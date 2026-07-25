import { createHash, randomUUID } from 'node:crypto';

import { resolveObserverDeliveryStatus } from '../config/settings/observer-activation.js';
import type {
  ObserverDeliveryIneligibleReason,
  ObserverDeliverySchedule,
} from '../config/settings/observer-activation.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings-types.js';
import type {
  ObserverDigestClaimMembership,
  ObserverDigestReservation,
  ObserverInsightRepository,
  ProactiveInsight,
} from '../domain/ports/observer-insights.js';
import {
  OBSERVER_MIN_CONFIDENCE,
  OBSERVER_MIN_EVIDENCE_COUNT,
} from '../shared/observer-insight-policy.js';
import type { InsightFreshnessProbe } from './observer-evidence-freshness.js';

// A claim left behind by a crashed prior tick is stale after one cron interval.
// The cron ticks every 30 min, so anything claimed before this cutoff and not
// tied to a live reservation is safe to release before we claim afresh.
const OBSERVER_DIGEST_CLAIM_STALE_MS = 30 * 60 * 1000;

/**
 * The seam T4 replaces with the real outbound send + settleDigest. In T3 the
 * pipeline only builds and reserves the digest; the port receives the reserved
 * row and does nothing durable. NEVER call settleDigest from here.
 */
export interface DigestDeliveryPort {
  deliver(reservation: ObserverDigestReservation): Promise<void>;
}

export const noopDigestDeliveryPort: DigestDeliveryPort = {
  async deliver() {
    // ponytail: intentional no-op; the real send + settle land in T4.
  },
};

export interface RunObserverDigestDeps {
  settings: RuntimeSettings;
  repository: ObserverInsightRepository;
  freshnessProbe: InsightFreshnessProbe;
  deliveryPort: DigestDeliveryPort;
  idFactory?: () => string;
}

export type RunObserverDigestSkipReason =
  | ObserverDeliveryIneligibleReason
  | 'before_send_window'
  | 'quiet_hours'
  | 'already_reserved'
  | 'no_qualifying_insights';

export type RunObserverDigestResult =
  | {
      status: 'reserved';
      reservationId: string;
      localDay: string;
      selected: number;
    }
  | { status: 'skipped'; reason: RunObserverDigestSkipReason };

export async function runObserverDigest(input: {
  appId: string;
  nowIso: string;
  deps: RunObserverDigestDeps;
}): Promise<RunObserverDigestResult> {
  const { appId, nowIso, deps } = input;
  const status = resolveObserverDeliveryStatus(deps.settings);
  if (!status.eligible) {
    return { status: 'skipped', reason: status.reason };
  }
  const { owner, schedule } = status;

  const clock = ownerLocalClock(nowIso, schedule.timezone);
  if (clock.minutes < parseHhMm(schedule.sendAt)) {
    return { status: 'skipped', reason: 'before_send_window' };
  }
  if (withinQuietHours(clock.minutes, schedule.quietHours)) {
    return { status: 'skipped', reason: 'quiet_hours' };
  }

  const repository = deps.repository;

  // Release claims stranded by a crashed prior tick (recover excludes claims
  // held by a live reservation), then claim a generous prefetch so freshness
  // and floor drops still leave enough survivors to fill maxInsights.
  await repository.recoverStaleDigestClaims({
    appId,
    staleBeforeIso: new Date(
      Date.parse(nowIso) - OBSERVER_DIGEST_CLAIM_STALE_MS,
    ).toISOString(),
    nowIso,
  });

  const claimed = await repository.claimPendingForDigest({
    appId,
    recipient: owner.recipient,
    limit: prefetchLimit(schedule),
    nowIso,
  });

  // Freshness + value floor: drop (release) any claimed insight whose
  // conversation moved on, or that no longer clears the confidence/evidence
  // floor. Survivors stay claimed for now.
  const survivors: ProactiveInsight[] = [];
  const toRelease: ProactiveInsight[] = [];
  for (const insight of claimed) {
    const stale = await deps.freshnessProbe.isStale(insight);
    if (stale || !clearsFloor(insight)) {
      toRelease.push(insight);
    } else {
      survivors.push(insight);
    }
  }

  // Stable top-N: claimPendingForDigest already returns priority desc then
  // createdAt/id asc; re-sort defensively before capping.
  survivors.sort(compareForSelection);
  const cap = Math.min(schedule.maxInsights, survivors.length);
  const selected = survivors.slice(0, cap);
  toRelease.push(...survivors.slice(cap));

  await releaseClaims(repository, toRelease, nowIso);

  if (selected.length === 0) {
    // Below threshold => no send, no reservation (the "no qualifying insights"
    // rule). All claims were already released above.
    return { status: 'skipped', reason: 'no_qualifying_insights' };
  }

  const memberships: ObserverDigestClaimMembership[] = selected.map(
    (insight, position) => ({
      insightId: insight.id,
      claimedAt: nowIso,
      position,
    }),
  );
  const renderedDigest = renderDigest(clock.localDay, selected);
  const contentHash = digestContentHash(selected);

  const reserve = await repository.reserveDigest({
    id: (deps.idFactory ?? randomUUID)(),
    appId,
    recipient: owner.recipient,
    localDay: clock.localDay,
    timezone: schedule.timezone,
    conversationJid: owner.conversationJid,
    providerAccountId: owner.providerAccountId,
    threadId: null,
    renderedDigest,
    contentHash,
    memberships,
    nowIso,
  });

  if (!reserve.created) {
    // Today's digest was already reserved (a prior tick, or a concurrent run).
    // The reservation is at-most-once, so release our just-claimed insights and
    // do NOT hand off — the earlier reservation owns delivery.
    await releaseClaims(repository, selected, nowIso);
    return { status: 'skipped', reason: 'already_reserved' };
  }

  // Hand the reserved digest to the delivery seam. In T3 this is a no-op; T4
  // performs the real outbound send + settleDigest.
  await deps.deliveryPort.deliver(reserve.reservation);

  return {
    status: 'reserved',
    reservationId: reserve.reservation.id,
    localDay: clock.localDay,
    selected: selected.length,
  };
}

function clearsFloor(insight: ProactiveInsight): boolean {
  return (
    insight.confidence >= OBSERVER_MIN_CONFIDENCE &&
    (insight.evidenceRefs?.length ?? 0) >= OBSERVER_MIN_EVIDENCE_COUNT
  );
}

function compareForSelection(
  left: ProactiveInsight,
  right: ProactiveInsight,
): number {
  if (left.priorityScore !== right.priorityScore) {
    return right.priorityScore - left.priorityScore;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

async function releaseClaims(
  repository: ObserverInsightRepository,
  insights: ProactiveInsight[],
  nowIso: string,
): Promise<void> {
  for (const insight of insights) {
    await repository.transitionState({
      id: insight.id,
      from: 'claimed',
      to: 'pending',
      nowIso,
    });
  }
}

function prefetchLimit(schedule: ObserverDeliverySchedule): number {
  return Math.max(schedule.maxInsights * 3, 30);
}

function renderDigest(localDay: string, insights: ProactiveInsight[]): string {
  const lines = [`Observer digest — ${localDay}`, ''];
  insights.forEach((insight, index) => {
    lines.push(`${index + 1}. ${insight.title}`);
    if (insight.summary) lines.push(`   ${insight.summary}`);
  });
  return lines.join('\n');
}

function digestContentHash(insights: ProactiveInsight[]): string {
  const canonical = insights.map((insight, position) => ({
    position,
    id: insight.id,
    title: insight.title,
    summary: insight.summary,
  }));
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}

/**
 * Owner-local calendar day (YYYY-MM-DD) and minutes-since-midnight, computed via
 * Intl.DateTimeFormat so DST and offsets come from the IANA zone — never
 * Date#getHours or a fixed offset.
 */
function ownerLocalClock(
  nowIso: string,
  timezone: string,
): { localDay: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowIso));
  const part = (type: string): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  const localDay = `${part('year')}-${part('month')}-${part('day')}`;
  // Node emits '24' for midnight under hour12:false on some versions.
  const hour = Number(part('hour')) % 24;
  const minutes = hour * 60 + Number(part('minute'));
  return { localDay, minutes };
}

function withinQuietHours(
  minutes: number,
  quietHours: ObserverDeliverySchedule['quietHours'],
): boolean {
  if (!quietHours) return false;
  const start = parseHhMm(quietHours.start);
  const end = parseHhMm(quietHours.end);
  if (start === end) return false;
  // Crossing midnight (start > end): quiet is [start, 24:00) ∪ [00:00, end).
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

function parseHhMm(value: string): number {
  const [hours, mins] = value.split(':');
  return Number(hours) * 60 + Number(mins);
}

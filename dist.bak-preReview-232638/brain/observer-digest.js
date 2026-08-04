import { createHash, randomUUID } from 'node:crypto';
import { resolveObserverDeliveryStatus } from '../config/settings/observer-activation.js';
import { OBSERVER_MIN_CONFIDENCE, OBSERVER_MIN_EVIDENCE_COUNT, } from '../shared/observer-insight-policy.js';
// A claim left behind by a crashed prior tick is stale after one cron interval.
// The cron ticks every 30 min, so anything claimed before this cutoff and not
// tied to a live reservation is safe to release before we claim afresh.
const OBSERVER_DIGEST_CLAIM_STALE_MS = 30 * 60 * 1000;
// Members of a sent digest cool down for a week before an equivalent insight can
// surface again. ponytail: single constant; make it configurable if per-owner
// tuning is ever needed.
export const OBSERVER_DIGEST_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const noopDigestDeliveryPort = {
    async deliver() {
        // ponytail: test-only no-op; production uses createOutboundDigestDeliveryPort.
    },
};
/** Deterministic per-(app, recipient, day) outbound idempotency key. */
export function digestOutboundIdempotencyKey(reservation) {
    return `observer-digest:${reservation.appId}:${reservation.recipient}:${reservation.localDay}`;
}
/**
 * Production delivery port: durable enqueue + settle-after-durable-sent.
 * - Enqueue is idempotent on the deterministic key, so re-driving a reservation
 *   never produces a duplicate outbound message.
 * - settleDigest (members sent -> cooldown) runs ONLY once the outbound is
 *   durably sent. A failed/pending send leaves the reservation UNSETTLED and its
 *   members claimed, so the next tick retries the same reservation.
 */
export function createOutboundDigestDeliveryPort(deps) {
    const cooldownMs = deps.cooldownMs ?? OBSERVER_DIGEST_COOLDOWN_MS;
    return {
        async deliver(reservation) {
            if (reservation.state === 'settled')
                return;
            if (!reservation.conversationJid ||
                !reservation.providerAccountId ||
                !reservation.renderedDigest) {
                throw new Error(`Observer digest reservation ${reservation.id} is missing route or rendered digest`);
            }
            const { outboundDeliveryId, durablySent } = await deps.gateway.enqueue({
                appId: reservation.appId,
                conversationJid: reservation.conversationJid,
                providerAccountId: reservation.providerAccountId,
                threadId: reservation.threadId,
                idempotencyKey: digestOutboundIdempotencyKey(reservation),
                text: reservation.renderedDigest,
            });
            // Invariant: never settle before the outbound is durably sent.
            if (!durablySent)
                return;
            const now = deps.now();
            await deps.repository.settleDigest({
                deliveryId: reservation.id,
                outboundDeliveryId,
                cooldownUntil: new Date(Date.parse(now) + cooldownMs).toISOString(),
                nowIso: now,
            });
        },
    };
}
export async function runObserverDigest(input) {
    const { appId, nowIso, deps } = input;
    const status = resolveObserverDeliveryStatus(deps.settings);
    if (!status.eligible) {
        return { status: 'skipped', reason: status.reason };
    }
    const { owner, schedule } = status;
    const repository = deps.repository;
    const clock = ownerLocalClock(nowIso, schedule.timezone);
    // Retry backlog FIRST, across ALL days (not just today): a reservation left
    // unsettled just before local midnight must still be found and re-driven on
    // the next day's tick, or its claimed members are orphaned forever. A retry
    // was already due when created, so it is gated ONLY by quiet hours (never
    // re-blocked by sendAt).
    const unsettled = await repository.findUnsettledDigestReservations({
        appId,
        recipient: owner.recipient,
    });
    if (unsettled.length > 0) {
        if (withinQuietHours(clock.minutes, schedule.quietHours)) {
            // Do NOT send during quiet hours (the reservation may have no outbound
            // record yet); leave it reserved and retry after quiet-end.
            return { status: 'skipped', reason: 'deferred_quiet_hours' };
        }
        for (const reservation of unsettled) {
            await deps.deliveryPort.deliver(reservation);
        }
        // Don't claim new insights while a backlog reservation is outstanding.
        return {
            status: 'retried',
            reservationId: unsettled[0].id,
            localDay: clock.localDay,
        };
    }
    // No unsettled backlog. If today's reservation exists it must be settled
    // (unsettled ones were handled above) -> already delivered, nothing to do.
    const today = await repository.findDigestReservation({
        appId,
        recipient: owner.recipient,
        localDay: clock.localDay,
    });
    if (today) {
        return { status: 'skipped', reason: 'already_delivered' };
    }
    // Creating a NEW digest: apply the send-window gate. Cross-midnight-safe — if
    // the configured send time falls inside the quiet window, defer to quiet-end
    // (morning-after) so a quiet window can never permanently block delivery.
    const effectiveEarliest = effectiveEarliestSendMinutes(schedule);
    if (clock.minutes < effectiveEarliest) {
        return { status: 'skipped', reason: 'before_send_window' };
    }
    if (withinQuietHours(clock.minutes, schedule.quietHours)) {
        return { status: 'skipped', reason: 'quiet_hours' };
    }
    // Release claims stranded by a crashed prior tick (recover excludes claims
    // held by a live reservation), then claim a generous prefetch so freshness
    // and floor drops still leave enough survivors to fill maxInsights.
    await repository.recoverStaleDigestClaims({
        appId,
        staleBeforeIso: new Date(Date.parse(nowIso) - OBSERVER_DIGEST_CLAIM_STALE_MS).toISOString(),
        nowIso,
    });
    const claimed = await repository.claimPendingForDigest({
        appId,
        recipient: owner.recipient,
        limit: prefetchLimit(schedule),
        nowIso,
    });
    // Freshness + value floor. A stale or below-floor insight can never become
    // eligible, so it goes to the TERMINAL 'dropped' state (NOT back to pending),
    // otherwise it would be re-claimed every tick forever and starve the pool.
    const survivors = [];
    const toDrop = [];
    for (const insight of claimed) {
        const stale = await deps.freshnessProbe.isStale(insight);
        if (stale || !clearsFloor(insight)) {
            toDrop.push(insight);
        }
        else {
            survivors.push(insight);
        }
    }
    // Stable top-N: claimPendingForDigest already returns priority desc then
    // createdAt/id asc; re-sort defensively before capping.
    survivors.sort(compareForSelection);
    const cap = Math.min(schedule.maxInsights, survivors.length);
    const selected = survivors.slice(0, cap);
    // Unselected survivors are still fresh + eligible (just not today's top-N):
    // release them back to pending for a future day.
    const toReleaseToPending = survivors.slice(cap);
    await dropClaims(repository, toDrop, nowIso);
    await releaseClaims(repository, toReleaseToPending, nowIso);
    if (selected.length === 0) {
        // Below threshold => no send, no reservation. All claims were resolved above.
        return { status: 'skipped', reason: 'no_qualifying_insights' };
    }
    const memberships = selected.map((insight, position) => ({
        insightId: insight.id,
        claimedAt: insight.updatedAt,
        position,
    }));
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
        // Lost a race: another run already reserved today. Release our claims and
        // let that reservation own delivery.
        await releaseClaims(repository, selected, nowIso);
        return { status: 'skipped', reason: 'already_reserved' };
    }
    await deps.deliveryPort.deliver(reserve.reservation);
    return {
        status: 'reserved',
        reservationId: reserve.reservation.id,
        localDay: clock.localDay,
        selected: selected.length,
    };
}
/**
 * Dry-run digest assembly: apply the SAME freshness + value floor + stable
 * top-N selection + render that runObserverDigest uses, over a caller-supplied
 * candidate pool. Claim-free, reserve-free, send-free — it reads freshness and
 * returns what WOULD be sent, writing nothing. The candidate pool must be read
 * with listPendingForDigest (not claimPendingForDigest) to keep it that way.
 */
export async function buildDigestPreview(input) {
    const localDay = ownerLocalClock(input.nowIso, input.timezone).localDay;
    const survivors = [];
    for (const insight of input.candidates) {
        const stale = await input.freshnessProbe.isStale(insight);
        if (!stale && clearsFloor(insight))
            survivors.push(insight);
    }
    survivors.sort(compareForSelection);
    const selected = survivors.slice(0, Math.min(input.maxInsights, survivors.length));
    return {
        localDay,
        selected,
        renderedDigest: selected.length > 0 ? renderDigest(localDay, selected) : null,
        skippedReason: selected.length === 0 ? 'no_qualifying_insights' : null,
    };
}
/** Generous prefetch so freshness + floor drops still leave enough survivors. */
export function digestPrefetchLimit(maxInsights) {
    return Math.max(maxInsights * 3, 30);
}
function clearsFloor(insight) {
    return (insight.confidence >= OBSERVER_MIN_CONFIDENCE &&
        (insight.evidenceRefs?.length ?? 0) >= OBSERVER_MIN_EVIDENCE_COUNT);
}
function compareForSelection(left, right) {
    if (left.priorityScore !== right.priorityScore) {
        return right.priorityScore - left.priorityScore;
    }
    if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
async function releaseClaims(repository, insights, nowIso) {
    for (const insight of insights) {
        await repository.transitionState({
            id: insight.id,
            from: 'claimed',
            to: 'pending',
            claimedAt: insight.updatedAt,
            nowIso,
        });
    }
}
async function dropClaims(repository, insights, nowIso) {
    for (const insight of insights) {
        await repository.transitionState({
            id: insight.id,
            from: 'claimed',
            to: 'dropped',
            claimedAt: insight.updatedAt,
            nowIso,
        });
    }
}
function prefetchLimit(schedule) {
    return digestPrefetchLimit(schedule.maxInsights);
}
function renderDigest(localDay, insights) {
    const lines = [`Observer digest — ${localDay}`, ''];
    insights.forEach((insight, index) => {
        lines.push(`${index + 1}. ${insight.title}`);
        if (insight.summary)
            lines.push(`   ${insight.summary}`);
    });
    return lines.join('\n');
}
function digestContentHash(insights) {
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
function ownerLocalClock(nowIso, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date(nowIso));
    const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '';
    const localDay = `${part('year')}-${part('month')}-${part('day')}`;
    // Node emits '24' for midnight under hour12:false on some versions.
    const hour = Number(part('hour')) % 24;
    const minutes = hour * 60 + Number(part('minute'));
    return { localDay, minutes };
}
/**
 * Earliest owner-local minute a digest may send: the configured send time, or —
 * when that time falls inside the quiet window — the quiet-window end.
 */
function effectiveEarliestSendMinutes(schedule) {
    const sendAt = parseHhMm(schedule.sendAt);
    if (schedule.quietHours && withinQuietHours(sendAt, schedule.quietHours)) {
        return parseHhMm(schedule.quietHours.end);
    }
    return sendAt;
}
function withinQuietHours(minutes, quietHours) {
    if (!quietHours)
        return false;
    const start = parseHhMm(quietHours.start);
    const end = parseHhMm(quietHours.end);
    if (start === end)
        return false;
    // Crossing midnight (start > end): quiet is [start, 24:00) ∪ [00:00, end).
    return start < end
        ? minutes >= start && minutes < end
        : minutes >= start || minutes < end;
}
function parseHhMm(value) {
    const [hours, mins] = value.split(':');
    return Number(hours) * 60 + Number(mins);
}

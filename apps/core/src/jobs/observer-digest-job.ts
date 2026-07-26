import { getRuntimeSettingsForConfig } from '../config/index.js';
import type { resolveObserverDeliveryStatus } from '../config/settings/observer-activation.js';
import { DEFAULT_MEMORY_APP_ID } from '../memory/app-memory-boundaries.js';
import {
  OBSERVER_DIGEST_JOB_ID_PREFIX,
  OBSERVER_DIGEST_SYSTEM_PROMPT,
} from '../shared/system-job-identity.js';
import {
  runObserverDigest,
  noopDigestDeliveryPort,
  createOutboundDigestDeliveryPort,
  type DigestSendGateway,
} from '../brain/observer-digest.js';
import { MessageInsightFreshnessProbe } from '../brain/observer-evidence-freshness.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { nowIso as currentIso } from '../shared/time/datetime.js';
import { computeNextJobRun } from './schedule-math.js';
import { buildCanonicalJobLifecycleTarget } from './job-notification-routes.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { ConversationRoute } from '../domain/types.js';
import type { SchedulerDependencies } from './types.js';

export const OBSERVER_DIGEST_TIMEOUT_MS = 5 * 60 * 1000;
// A frequent tick that self-gates on owner-local send time + the daily
// reservation, so no DST-aware exact-time cron is needed.
export const OBSERVER_DIGEST_CRON = '*/30 * * * *';
export const OBSERVER_DIGEST_JOB_ID = `${OBSERVER_DIGEST_JOB_ID_PREFIX}${DEFAULT_MEMORY_APP_ID}`;

type ObserverDeliveryStatus = ReturnType<typeof resolveObserverDeliveryStatus>;

// Registered at bootstrap (runtime-services) where the OutboundDeliveryService
// lives. Until then the digest handler falls back to the no-op port so a digest
// is reserved but not sent (and retried once the gateway is wired).
let observerDigestGateway: DigestSendGateway | null = null;

export function setObserverDigestGateway(
  gateway: DigestSendGateway | null,
): void {
  observerDigestGateway = gateway;
}

// Registration-signature fields so a change in observer eligibility/owner
// re-triggers a full re-registration pass.
export function observerRegistrationSignatureFields(
  observerDeliveryStatus: ObserverDeliveryStatus,
): {
  observerDigestEligible: boolean;
  observerDigestCron: string;
  observerDigestOwner: string | null;
} {
  return {
    observerDigestEligible: observerDeliveryStatus.eligible,
    observerDigestCron: OBSERVER_DIGEST_CRON,
    observerDigestOwner: observerDeliveryStatus.eligible
      ? `${observerDeliveryStatus.owner.conversationJid}|${observerDeliveryStatus.owner.providerAccountId}|${observerDeliveryStatus.owner.recipient}`
      : null,
  };
}

// One app-wide observer digest job, targeted at the resolved OWNER route
// (bare conversationJid + providerAccountId), NOT a route-registry key. The
// handler self-gates on owner-local send time + the daily reservation, so a
// frequent tick is correct; silent because generic lifecycle receipts are
// suppressed (the digest itself is the only user-facing message, sent in T4).
export async function registerObserverDigestJob(
  deps: SchedulerDependencies,
  input: {
    observerDeliveryStatus: ObserverDeliveryStatus;
    primary: { jid: string; group: ConversationRoute } | undefined;
    nowIso: string;
  },
): Promise<void> {
  const { observerDeliveryStatus, primary, nowIso } = input;
  if (!observerDeliveryStatus.eligible || !primary) return;
  const existing = await deps.opsRepository.getJobById(OBSERVER_DIGEST_JOB_ID);
  const target = buildCanonicalJobLifecycleTarget({
    conversationJid: observerDeliveryStatus.owner.conversationJid,
    workspaceKey: primary.group.folder,
    threadId: null,
    providerAccountId: observerDeliveryStatus.owner.providerAccountId,
    label: 'Observer digest',
  });
  const computedNextRun = computeNextJobRun(
    { schedule_type: 'cron', schedule_value: OBSERVER_DIGEST_CRON },
    nowIso,
  );
  const observerDigestJob = {
    id: OBSERVER_DIGEST_JOB_ID,
    name: 'Observer Digest',
    prompt: OBSERVER_DIGEST_SYSTEM_PROMPT,
    schedule_type: 'cron',
    schedule_value: OBSERVER_DIGEST_CRON,
    session_id: null,
    workspace_key: primary.group.folder,
    created_by: 'agent',
    status: existing?.status === 'paused' ? 'paused' : 'active',
    next_run: existing?.next_run || computedNextRun,
    silent: true,
    timeout_ms: OBSERVER_DIGEST_TIMEOUT_MS,
    max_retries: 1,
    retry_backoff_ms: 30_000,
    max_consecutive_failures: 3,
    execution_context: target.executionContext,
    notification_routes: target.notificationRoutes,
  };
  await deps.opsRepository.upsertJob(
    observerDigestJob as unknown as Parameters<
      SchedulerDependencies['opsRepository']['upsertJob']
    >[0],
  );
}

export async function runScheduledObserverDigest(
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const storage = getRuntimeStorage();
  const repository = storage.repositories.observerInsights;
  if (!observerDigestGateway) {
    logger.warn(
      {},
      'observer digest gateway is not registered; reserving without sending (will retry once wired)',
    );
  }
  const deliveryPort = observerDigestGateway
    ? createOutboundDigestDeliveryPort({
        gateway: observerDigestGateway,
        repository,
        now: () => currentIso(),
      })
    : noopDigestDeliveryPort;
  const result = await runObserverDigest({
    appId: DEFAULT_MEMORY_APP_ID,
    nowIso: currentIso(),
    deps: {
      settings: getRuntimeSettingsForConfig(),
      repository,
      freshnessProbe: new MessageInsightFreshnessProbe(storage.ops),
      deliveryPort,
    },
  });
  if (result.status === 'reserved') {
    return `Observer digest reserved for ${result.localDay}: ${result.selected} insight(s).`;
  }
  if (result.status === 'retried') {
    return `Observer digest delivery retried for ${result.localDay}.`;
  }
  return `Observer digest skipped: ${result.reason}.`;
}

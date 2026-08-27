import type { OutboundDeliveryService } from '../../application/outbound-delivery/outbound-delivery-service.js';
import type { OutboundDeliveryRepository } from '../../domain/ports/repositories.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import { SETUP_REQUIRED_PAUSE_REASON } from '../../domain/jobs/jobs.js';
import { raiseSetupPausePermissionPrompt } from '../../application/jobs/setup-pause-permission-prompt.js';
import type { ClaimedOutboundDeliveryItem } from '../../domain/outbound-delivery/outbound-delivery.js';
import { nowIso } from '../../shared/time/datetime.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { dispatchPreparedPermissionCard } from '../../jobs/permission-card-delivery.js';
import { startSetupPromptReconciliationLoop } from '../../jobs/outbound-delivery-recovery.js';
export { setupPermissionCardProfile } from '../../jobs/permission-card-delivery.js';
import type {
  ChannelWiring,
  RecoveryDispatchPermit,
} from './channel-wiring-types.js';

export const PERMISSION_CARD_DISPATCH_ACTIVE = true;

// Separate supervised loop: reconciliation must never gate delivery
// claims (its lock waits and failures stay its own).
export function startRuntimePermissionCardReconciliation(
  repository: OutboundDeliveryRepository,
  opsRepository?: Pick<RuntimeJobRepository, 'listJobs'>,
  jobPermissionDurability?: { reconcile(): Promise<number> },
): void {
  if (!PERMISSION_CARD_DISPATCH_ACTIVE) return;
  startSetupPromptReconciliationLoop({
    run: async () => {
      const outcomes = await Promise.allSettled([
        (async () => {
          await reconcileRuntimePermissionCards(repository);
          await reRaiseUnnotifiedSetupPauses(opsRepository);
        })(),
        jobPermissionDurability?.reconcile() ?? Promise.resolve(),
      ]);
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected',
      );
      if (failure) throw failure.reason;
    },
    intervalMs: 5_000,
    warn: (meta, message) => logger.warn(meta, message),
  });
}

// Durable retry owner for a transiently failed card preparation: a
// setup-paused job is parked (next_run null), so nothing else re-raises
// its prompt until delivery marks notified_fingerprint. Preparation
// replays the active generation, so re-raising is idempotent (review R10).
async function reRaiseUnnotifiedSetupPauses(
  opsRepository?: Pick<RuntimeJobRepository, 'listJobs'>,
): Promise<void> {
  if (!opsRepository) return;
  // Paginate the WHOLE paused set: notified/silent paused rows would
  // otherwise permanently occupy a single fixed page and starve later
  // setup pauses (review R11).
  let pageAfter: { createdAt: string; id: string } | undefined;
  for (;;) {
    const page = await opsRepository.listJobs({
      statuses: ['paused'],
      limit: 50,
      orderBy: 'created_at',
      ...(pageAfter ? { pageAfter } : {}),
    });
    for (const job of page) {
      const setup = job.setup_state;
      if (
        job.pause_reason !== SETUP_REQUIRED_PAUSE_REASON ||
        !setup ||
        setup.state === 'ready' ||
        !setup.fingerprint ||
        setup.notified_fingerprint === setup.fingerprint
      ) {
        continue;
      }
      try {
        await raiseSetupPausePermissionPrompt({
          jobId: job.id,
          setupFingerprint: setup.fingerprint,
          source: 'partial_recovery',
        });
      } catch (err) {
        logger.warn(
          { err, jobId: job.id },
          'Setup prompt re-raise failed; will retry on the next tick',
        );
      }
    }
    const last = page.at(-1);
    if (page.length < 50 || !last) return;
    pageAfter = { createdAt: last.created_at, id: last.id };
  }
}

export async function reconcileRuntimePermissionCards(
  repository: OutboundDeliveryRepository,
): Promise<void> {
  await (
    repository as OutboundDeliveryRepository & {
      reconcileSetupPermissionPrompts?: (input: {
        now: string;
      }) => Promise<unknown>;
    }
  ).reconcileSetupPermissionPrompts?.({ now: nowIso() });
}

export function dispatchRuntimePermissionCard(input: {
  service: OutboundDeliveryService;
  claimed: ClaimedOutboundDeliveryItem;
  channelWiring: ChannelWiring;
  destinationJid: string;
  destinationThreadId?: string;
  providerAccountId: string;
  permit: RecoveryDispatchPermit;
}) {
  return dispatchPreparedPermissionCard({
    service: input.service,
    claimed: input.claimed,
    now: () => nowIso(),
    prepare: (permissionCardView) =>
      input.channelWiring.prepareProviderPermissionCardSend(
        input.destinationJid,
        input.claimed.item.canonicalText,
        {
          permit: input.permit,
          messageOptions: {
            providerAccountId: input.providerAccountId,
            ...(input.destinationThreadId
              ? { threadId: input.destinationThreadId }
              : {}),
            permissionCardView,
          },
        },
      ),
  });
}

import type { CapabilityTemplateApprovalIntentRepository } from '../shared/capability-template-amendment.js';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_MS = 20_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export type CapabilityTemplateApprovalTargetOutcome =
  | 'resumed'
  | 'superseded'
  | 'retry';

export interface CapabilityTemplateApprovalIntentRecoveryInput {
  repository: CapabilityTemplateApprovalIntentRepository;
  claimerId: string;
  recoverTarget(input: {
    appId: string;
    proposalId: string;
    capabilityId: string;
    jobId: string;
    expectedSetupFingerprint: string;
  }): Promise<CapabilityTemplateApprovalTargetOutcome>;
  now?: () => Date;
  limit?: number;
  leaseMs?: number;
}

export async function recoverCapabilityTemplateApprovalIntents(
  input: CapabilityTemplateApprovalIntentRecoveryInput,
): Promise<{ claimed: number; completed: number; pending: number }> {
  const clock = input.now ?? (() => new Date());
  // Adopt orphans FIRST: a readiness pause that committed after an
  // intent's final straggler scan reopens that intent here, so the claim
  // loop below picks it up (review R8 - tick-level serialization).
  try {
    await input.repository.adoptOrphanedApprovalTargets?.({
      now: clock().toISOString(),
    });
  } catch {
    // The sweep retries next tick; claiming continues regardless.
  }
  let completed = 0;
  let pending = 0;
  let claimedCount = 0;
  // ONE intent per claim: a shared batch lease taken up-front would let
  // later claims expire while earlier intents' target sets are processed,
  // inviting claim theft and duplicate recovery work (review R5).
  for (let round = 0; round < (input.limit ?? 10); round += 1) {
    const claimedAt = clock();
    const [intent] = await input.repository.claimDueApprovalIntents({
      claimerId: input.claimerId,
      now: claimedAt.toISOString(),
      leaseExpiresAt: new Date(
        claimedAt.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS),
      ).toISOString(),
      limit: 1,
    });
    if (!intent) break;
    claimedCount += 1;
    const outcomes: Array<{
      jobId: string;
      status: 'resumed' | 'superseded';
    }> = [];
    const errors: string[] = [];
    let leaseLost = false;
    for (const target of intent.targets) {
      // Renew before EACH target: an app-wide set with slow readiness
      // rechecks can outlive a single 20s lease (review R6). A failed
      // renewal means another worker holds the claim - stop side effects.
      const renewedAt = clock();
      const renewed = await input.repository.renewApprovalIntentClaim?.({
        intentId: intent.id,
        claimToken: intent.claimToken,
        leaseExpiresAt: new Date(
          renewedAt.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS),
        ).toISOString(),
        now: renewedAt.toISOString(),
      });
      if (renewed === false) {
        leaseLost = true;
        break;
      }
      // Heartbeat DURING the recovery too: one readiness recheck (with
      // credential/browser work) can outlive a single lease window; the
      // settle itself stays token-fenced either way (review R7).
      const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
      const heartbeat = setInterval(
        () => {
          const at = clock();
          void input.repository
            .renewApprovalIntentClaim?.({
              intentId: intent.id,
              claimToken: intent.claimToken,
              leaseExpiresAt: new Date(at.getTime() + leaseMs).toISOString(),
              now: at.toISOString(),
            })
            .catch(() => undefined);
        },
        Math.max(1_000, Math.floor(leaseMs / 2)),
      );
      heartbeat.unref?.();
      try {
        const outcome = await input.recoverTarget({
          appId: intent.appId,
          proposalId: intent.proposalId,
          capabilityId: intent.capabilityId,
          jobId: target.jobId,
          expectedSetupFingerprint: target.expectedSetupFingerprint,
        });
        if (outcome !== 'retry') {
          outcomes.push({ jobId: target.jobId, status: outcome });
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        clearInterval(heartbeat);
      }
    }
    if (leaseLost) {
      pending += 1;
      continue;
    }
    const settledAt = clock();
    const backoffMs = Math.min(
      DEFAULT_INTERVAL_MS * 2 ** Math.max(0, intent.attemptCount - 1),
      MAX_BACKOFF_MS,
    );
    const status = await input.repository.settleApprovalIntentClaim({
      intentId: intent.id,
      claimToken: intent.claimToken,
      outcomes,
      now: settledAt.toISOString(),
      nextAttemptAt: new Date(settledAt.getTime() + backoffMs).toISOString(),
      ...(errors.length > 0
        ? { error: errors.join('; ').slice(0, 2_000) }
        : {}),
    });
    if (status === 'completed' || status === 'superseded') completed += 1;
    else pending += 1;
  }
  return { claimed: claimedCount, completed, pending };
}

export interface CapabilityTemplateApprovalIntentRecoveryLoop {
  isRunning(): boolean;
  stop(): Promise<void>;
}

let activeLoop: CapabilityTemplateApprovalIntentRecoveryLoop | null = null;

export function startCapabilityTemplateApprovalIntentRecoveryLoop(
  input: CapabilityTemplateApprovalIntentRecoveryInput & {
    intervalMs?: number;
    warn?: (meta: Record<string, unknown>, message: string) => void;
  },
): CapabilityTemplateApprovalIntentRecoveryLoop {
  if (activeLoop) return activeLoop;
  const intervalMs = Math.max(250, input.intervalMs ?? DEFAULT_INTERVAL_MS);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref?.();
  };
  const tick = async () => {
    if (stopped || running) return;
    running = recoverCapabilityTemplateApprovalIntents(input)
      .then(() => undefined)
      .catch((err) => {
        input.warn?.(
          { err, claimerId: input.claimerId },
          'Capability-template approval-intent recovery run failed',
        );
      })
      .finally(() => {
        running = undefined;
        schedule();
      });
    await running;
  };
  const controller: CapabilityTemplateApprovalIntentRecoveryLoop = {
    isRunning: () => !stopped,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
      if (activeLoop === controller) activeLoop = null;
    },
  };
  activeLoop = controller;
  void tick();
  return controller;
}

export async function stopCapabilityTemplateApprovalIntentRecoveryLoop(): Promise<void> {
  await activeLoop?.stop();
}

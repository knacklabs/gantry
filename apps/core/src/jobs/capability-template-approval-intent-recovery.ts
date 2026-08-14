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
  const startedAt = clock();
  const intents = await input.repository.claimDueApprovalIntents({
    claimerId: input.claimerId,
    now: startedAt.toISOString(),
    leaseExpiresAt: new Date(
      startedAt.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS),
    ).toISOString(),
    limit: input.limit ?? 10,
  });
  let completed = 0;
  let pending = 0;
  for (const intent of intents) {
    const outcomes: Array<{
      jobId: string;
      status: 'resumed' | 'superseded';
    }> = [];
    const errors: string[] = [];
    for (const target of intent.targets) {
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
      }
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
  return { claimed: intents.length, completed, pending };
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

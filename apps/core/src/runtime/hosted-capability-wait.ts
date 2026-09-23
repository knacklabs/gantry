import { logger } from '../infrastructure/logging/logger.js';

interface HostedWaitScope {
  readonly appId?: string;
  readonly agentId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly runLeaseToken?: string;
  readonly runLeaseFencingVersion?: number;
}

interface HostedWait extends HostedWaitScope {
  readonly taskId: string;
  readonly deadlineAtMs: number;
  readonly verifyAuthority: () => Promise<void>;
}

// Process-local liveness only. Durable task/run authority remains the verifier's
// responsibility; model heartbeat content cannot create a registration.
const waits = new Set<HostedWait>();

export function registerVerifiedHostedCapabilityWait(
  wait: HostedWait,
): () => void {
  waits.add(wait);
  return () => {
    waits.delete(wait);
  };
}

export async function hasVerifiedHostedCapabilityWait(
  scope: HostedWaitScope,
): Promise<boolean> {
  if (
    !scope.appId ||
    !scope.agentId ||
    !scope.jobId ||
    !scope.runId ||
    !scope.runLeaseToken ||
    !Number.isSafeInteger(scope.runLeaseFencingVersion)
  )
    return false;
  const checkDeadlineAtMs = Date.now() + 3_000;
  for (const wait of waits) {
    if (Date.now() >= checkDeadlineAtMs) return false;
    if (
      wait.appId !== scope.appId ||
      wait.agentId !== scope.agentId ||
      wait.jobId !== scope.jobId ||
      wait.runId !== scope.runId ||
      wait.runLeaseToken !== scope.runLeaseToken ||
      wait.runLeaseFencingVersion !== scope.runLeaseFencingVersion ||
      wait.deadlineAtMs <= Date.now()
    )
      continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const valid = await Promise.race([
        wait.verifyAuthority().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            Math.max(
              0,
              Math.min(checkDeadlineAtMs, wait.deadlineAtMs) - Date.now(),
            ),
          );
        }),
      ]);
      if (valid && waits.has(wait) && wait.deadlineAtMs > Date.now())
        return true;
      logger.warn(
        { runId: scope.runId },
        'Hosted wait authority check timed out or execution ended',
      );
    } catch {
      // Failing closed is intentional: an unverifiable execution must not
      // suppress the ordinary idle watchdog. Never log lease credentials.
      logger.warn(
        { runId: scope.runId },
        'Hosted wait authority is no longer valid',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return false;
}

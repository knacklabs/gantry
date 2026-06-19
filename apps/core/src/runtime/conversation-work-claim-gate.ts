import type {
  ClaimConversationOwnerLeaseInput,
  ClaimConversationOwnerLeaseResult,
  ConversationOwnerLeaseRecord,
  HeartbeatConversationOwnerLeaseInput,
  ReleaseConversationOwnerLeaseInput,
} from '../domain/ports/conversation-owner-lease-repository.js';

interface ConversationWorkClaimGateInput {
  claimLease: (
    input: ClaimConversationOwnerLeaseInput,
  ) => Promise<ClaimConversationOwnerLeaseResult>;
  heartbeatLease?: (
    input: HeartbeatConversationOwnerLeaseInput,
  ) => Promise<ConversationOwnerLeaseRecord | null>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const DEFAULT_IN_FLIGHT_CLAIM_RELEASE_WAIT_MS = 1_000;

export interface ConversationWorkClaimGate {
  claimLease(
    input: ClaimConversationOwnerLeaseInput,
  ): Promise<ClaimConversationOwnerLeaseResult>;
  startTrackedLeaseHeartbeat(input: {
    appId: string;
    conversationId: string;
    threadId?: string | null;
    ownerInstanceId: string;
    leaseTtlMs: number;
    intervalMs: number;
  }): () => void;
  releaseTrackedLeases(input: {
    releaseLease: (
      releaseInput: ReleaseConversationOwnerLeaseInput,
    ) => Promise<boolean>;
    inFlightClaimWaitMs?: number;
  }): Promise<void>;
  close(reason?: string): void;
}

function trackedLeaseKey(lease: ConversationOwnerLeaseRecord): string {
  return [
    lease.appId,
    lease.conversationId,
    lease.threadId ?? '',
    lease.ownerInstanceId,
  ].join('\0');
}

function trackedLeaseKeyFromInput(input: {
  appId: string;
  conversationId: string;
  threadId?: string | null;
  ownerInstanceId: string;
}): string {
  return [
    input.appId,
    input.conversationId,
    input.threadId ?? '',
    input.ownerInstanceId,
  ].join('\0');
}

function releaseInputFromLease(
  lease: ConversationOwnerLeaseRecord,
): ReleaseConversationOwnerLeaseInput {
  return {
    appId: lease.appId,
    conversationId: lease.conversationId,
    threadId: lease.threadId,
    ownerInstanceId: lease.ownerInstanceId,
    leaseVersion: lease.leaseVersion,
  };
}

function closedClaimsError(reason: string): Error {
  return new Error(`Conversation work owner claims are closed: ${reason}`);
}

export function createConversationWorkClaimGate(
  input: ConversationWorkClaimGateInput,
): ConversationWorkClaimGate {
  let closedReason: string | undefined;
  const trackedLeases = new Map<string, ReleaseConversationOwnerLeaseInput>();
  const inFlightClaims = new Set<Promise<void>>();
  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;

  async function waitForInFlightClaims(timeoutMs: number): Promise<void> {
    const deadlineMs = Date.now() + Math.max(0, timeoutMs);
    while (inFlightClaims.size > 0) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) return;

      const currentClaims = Array.from(inFlightClaims);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), remainingMs);
      });
      const result = await Promise.race([
        Promise.allSettled(currentClaims).then(() => 'claims_settled' as const),
        timeout,
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (result === 'timeout') return;
    }
  }

  return {
    async claimLease(claimInput) {
      if (closedReason) {
        throw closedClaimsError(closedReason);
      }
      const claim = input.claimLease(claimInput);
      const inFlight = claim.then(
        () => undefined,
        () => undefined,
      );
      inFlightClaims.add(inFlight);
      try {
        const result = await claim;
        if (result.acquired) {
          trackedLeases.set(
            trackedLeaseKey(result.lease),
            releaseInputFromLease(result.lease),
          );
        }
        if (closedReason) {
          throw closedClaimsError(closedReason);
        }
        return result;
      } finally {
        inFlightClaims.delete(inFlight);
      }
    },
    startTrackedLeaseHeartbeat(heartbeatInput) {
      if (!input.heartbeatLease || closedReason) return () => undefined;
      const key = trackedLeaseKeyFromInput(heartbeatInput);
      let stopped = false;
      let running = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        if (timer) clearIntervalFn(timer);
      };
      const heartbeat = async (): Promise<void> => {
        if (stopped || running || closedReason) return;
        const tracked = trackedLeases.get(key);
        if (!tracked) {
          stop();
          return;
        }
        running = true;
        try {
          const refreshed = await input.heartbeatLease!({
            appId: tracked.appId,
            conversationId: tracked.conversationId,
            threadId: tracked.threadId,
            ownerInstanceId: tracked.ownerInstanceId,
            leaseVersion: tracked.leaseVersion,
            leaseTtlMs: heartbeatInput.leaseTtlMs,
          });
          if (!refreshed) {
            trackedLeases.delete(key);
            stop();
            return;
          }
          trackedLeases.set(key, releaseInputFromLease(refreshed));
        } finally {
          running = false;
        }
      };
      const timer = setIntervalFn(
        () => {
          void heartbeat();
        },
        Math.max(1, heartbeatInput.intervalMs),
      );
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
      return stop;
    },
    async releaseTrackedLeases({ releaseLease, inFlightClaimWaitMs }) {
      await waitForInFlightClaims(
        inFlightClaimWaitMs ?? DEFAULT_IN_FLIGHT_CLAIM_RELEASE_WAIT_MS,
      );
      const releases = Array.from(trackedLeases.values());
      trackedLeases.clear();
      let firstError: unknown;
      for (const releaseInput of releases) {
        try {
          await releaseLease(releaseInput);
        } catch (err) {
          firstError ??= err;
        }
      }
      if (firstError) throw firstError;
    },
    close(reason = 'closed') {
      closedReason = reason;
    },
  };
}

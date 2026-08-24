import {
  getPermissionTimeoutMs,
  NO_PERMISSION_TIMEOUT_MS,
} from '../shared/permission-timeout.js';
import type {
  PermissionApprovalCancellation,
  PermissionApprovalRequest,
  UserQuestionCancellation,
  UserQuestionRequest,
} from '../domain/types.js';
import { resolvePendingInteractionRecordOutcome } from '../application/interactions/pending-interaction-durability.js';

export const RUNNER_CANCELLED_PERMISSION_REASON =
  'Permission request cancelled by its runner.';
export const RUNNER_CANCELLED_QUESTION_REASON =
  'Question cancelled by its runner.';

export type InteractionCancellationResult =
  | 'settled'
  | 'already_decided'
  | 'retryable'
  | 'not_found';

export function pendingPermissionAliasesForCancellation<
  Pending extends {
    request: Pick<
      PermissionApprovalRequest,
      'requestId' | 'appId' | 'sourceAgentFolder'
    >;
  },
>(
  pendingByAlias: ReadonlyMap<string, Pending>,
  cancellation: PermissionApprovalCancellation,
): string[] {
  const appId = cancellation.appId || 'default';
  return [...pendingByAlias]
    .filter(
      ([, pending]) =>
        pending.request.requestId === cancellation.requestId &&
        pending.request.sourceAgentFolder === cancellation.sourceAgentFolder &&
        (pending.request.appId || 'default') === appId,
    )
    .map(([providerAlias]) => providerAlias);
}

export function matchesQuestionCancellation(
  request: Pick<
    UserQuestionRequest,
    'requestId' | 'appId' | 'sourceAgentFolder'
  >,
  cancellation: UserQuestionCancellation,
): boolean {
  return (
    request.requestId === cancellation.requestId &&
    request.sourceAgentFolder === cancellation.sourceAgentFolder &&
    (request.appId || 'default') === (cancellation.appId || 'default')
  );
}

export async function settlePendingQuestionCancellation(
  cancellation: UserQuestionCancellation,
): Promise<Exclude<InteractionCancellationResult, 'not_found'>> {
  const outcome = await resolvePendingInteractionRecordOutcome({
    kind: 'question',
    sourceAgentFolder: cancellation.sourceAgentFolder,
    requestId: cancellation.requestId,
    appId: cancellation.appId,
    status: 'cancelled',
    resolution: {
      answers: {},
      reason: cancellation.reason ?? RUNNER_CANCELLED_QUESTION_REASON,
    },
    approverRef: null,
  });
  if (outcome === 'resolved') return 'settled';
  if (outcome === 'retryable_error') return 'retryable';
  return 'already_decided';
}

export async function cancelMatchingPendingQuestions<Pending>(input: {
  pending: Iterable<Pending>;
  cancellation: UserQuestionCancellation;
  request: (
    pending: Pending,
  ) => Pick<UserQuestionRequest, 'requestId' | 'appId' | 'sourceAgentFolder'>;
  settle: (pending: Pending, reason: string) => Promise<void>;
}): Promise<InteractionCancellationResult> {
  const pendingQuestions = [...new Set(input.pending)].filter((pending) =>
    matchesQuestionCancellation(input.request(pending), input.cancellation),
  );
  if (pendingQuestions.length === 0) return 'not_found';
  const settled = await settlePendingQuestionCancellation(input.cancellation);
  if (settled !== 'settled') return settled;
  const reason = input.cancellation.reason ?? RUNNER_CANCELLED_QUESTION_REASON;
  await Promise.all(
    pendingQuestions.map((pending) => input.settle(pending, reason)),
  );
  return 'settled';
}

export function resolveInteractionSettlementDelayMs(input: {
  expiresAt?: unknown;
  isPermissionRequest?: boolean;
  jobId?: string;
  permissionLane?: 'interactive' | 'autonomous';
  fallbackTimeoutMs?: number;
}): number | undefined {
  const expiresAtMs =
    typeof input.expiresAt === 'string'
      ? Date.parse(input.expiresAt)
      : Number.NaN;
  if (Number.isFinite(expiresAtMs)) {
    return Math.max(0, expiresAtMs - Date.now());
  }
  if (input.isPermissionRequest && input.jobId?.trim()) {
    return undefined;
  }
  if (input.permissionLane) {
    const timeoutMs = getPermissionTimeoutMs(input.permissionLane);
    return timeoutMs > NO_PERMISSION_TIMEOUT_MS ? timeoutMs : undefined;
  }
  if (
    input.fallbackTimeoutMs !== undefined &&
    input.fallbackTimeoutMs > NO_PERMISSION_TIMEOUT_MS
  ) {
    return input.fallbackTimeoutMs;
  }
  return undefined;
}

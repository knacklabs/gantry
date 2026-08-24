import {
  getPermissionTimeoutMs,
  NO_PERMISSION_TIMEOUT_MS,
} from '../shared/permission-timeout.js';
import type {
  MessageActionAffordance,
  PermissionApprovalCancellation,
  PermissionApprovalRequest,
  UserQuestionCancellation,
  UserQuestionRequest,
} from '../domain/types.js';
import { parseJobPermissionCardAction } from '../domain/job-permission-card-actions.js';
import { resolvePendingInteractionRecordOutcome } from '../application/interactions/pending-interaction-durability.js';

export const RUNNER_CANCELLED_PERMISSION_REASON =
  'Permission request cancelled by its runner.';
export const RUNNER_CANCELLED_QUESTION_REASON =
  'Question cancelled by its runner.';

type JobPermissionCardRevision = { callbackKey: string; revision: number };

/**
 * A provider delivery is meaningful only for one rendered card revision. Do
 * not let a successfully delivered revision get re-sent just because the
 * caller retries its completed delivery work.
 */
export class JobPermissionCardDeliverySettlement {
  private readonly delivered = new Map<string, string>();

  deliveredMessageId(actions?: MessageActionAffordance[]): string | undefined {
    const revision = jobPermissionCardRevision(actions);
    return revision ? this.delivered.get(revisionKey(revision)) : undefined;
  }

  previousMessageId(actions?: MessageActionAffordance[]): string | undefined {
    const revision = jobPermissionCardRevision(actions);
    if (!revision) return undefined;
    let latest: { revision: number; messageId: string } | undefined;
    for (const [key, messageId] of this.delivered) {
      const [callbackKey, rawRevision] = key.split(':');
      const deliveredRevision = Number(rawRevision);
      if (
        callbackKey === revision.callbackKey &&
        deliveredRevision < revision.revision &&
        (!latest || deliveredRevision > latest.revision)
      ) {
        latest = { revision: deliveredRevision, messageId };
      }
    }
    return latest?.messageId;
  }

  record(actions: MessageActionAffordance[] | undefined, messageId: string) {
    const revision = jobPermissionCardRevision(actions);
    if (revision) this.delivered.set(revisionKey(revision), messageId);
  }
}

export function jobPermissionCardRevision(
  actions?: MessageActionAffordance[],
): JobPermissionCardRevision | undefined {
  if (
    !actions?.length ||
    actions.some((action) => action.kind !== 'job_permission_decision')
  ) {
    return undefined;
  }
  const cardActions = actions.filter(
    (
      action,
    ): action is Extract<
      MessageActionAffordance,
      { kind: 'job_permission_decision' }
    > => action.kind === 'job_permission_decision',
  );
  const parsed = cardActions.map((action) =>
    parseJobPermissionCardAction(action.actionToken),
  );
  const first = parsed[0];
  if (
    !first ||
    parsed.some(
      (action) =>
        !action ||
        action.callbackKey !== first.callbackKey ||
        action.revision !== first.revision,
    )
  ) {
    return undefined;
  }
  return { callbackKey: first.callbackKey, revision: first.revision };
}

function revisionKey(revision: JobPermissionCardRevision): string {
  return `${revision.callbackKey}:${revision.revision}`;
}

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

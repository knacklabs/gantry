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

export type JobPermissionCardRevision = {
  callbackKey: string;
  revision: number;
};

/**
 * A provider message carries exactly one card per callback key. Only the
 * newest delivered revision matters: a retry of an already-delivered or
 * older revision must not mutate the provider again, and mutations for one
 * card are serialized so concurrent retries cannot both send.
 */
export class JobPermissionCardDeliverySettlement {
  private readonly latest = new Map<
    string,
    { revision: number; messageId: string }
  >();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly laneByMessage = new Map<string, string>();

  async serialize<T>(callbackKey: string, work: () => Promise<T>): Promise<T> {
    const prior = this.lanes.get(callbackKey) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.lanes.set(callbackKey, next);
    try {
      return await next;
    } finally {
      if (this.lanes.get(callbackKey) === next) this.lanes.delete(callbackKey);
    }
  }

  /** Message already carrying this revision or a newer one. */
  settledMessageId(revision: JobPermissionCardRevision): string | undefined {
    const latest = this.latest.get(revision.callbackKey);
    return latest && latest.revision >= revision.revision
      ? latest.messageId
      : undefined;
  }

  /** Message carrying an older revision that this one should edit in place. */
  previousMessageId(revision: JobPermissionCardRevision): string | undefined {
    const latest = this.latest.get(revision.callbackKey);
    return latest && latest.revision < revision.revision
      ? latest.messageId
      : undefined;
  }

  /** Lane a later buttonless (retire/replace) edit of this message must join. */
  laneForMessage(messageKey: string): string {
    return this.laneByMessage.get(messageKey) ?? `message:${messageKey}`;
  }

  /** Bind a message to a card lane before its first mutation is awaited. */
  bindMessage(messageKey: string, callbackKey: string) {
    this.laneByMessage.set(messageKey, callbackKey);
  }

  record(
    revision: JobPermissionCardRevision,
    messageId: string,
    messageKey: string,
  ) {
    this.bindMessage(messageKey, revision.callbackKey);
    const latest = this.latest.get(revision.callbackKey);
    if (!latest || latest.revision <= revision.revision) {
      this.latest.set(revision.callbackKey, {
        revision: revision.revision,
        messageId,
      });
    }
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

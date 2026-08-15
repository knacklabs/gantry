import { decisionForMode as domainDecisionForMode } from '../../domain/permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackScope,
} from '../../domain/types.js';
import {
  claimPermissionInteractionCallback,
  findDurablePermissionInteractionByRequestId,
  resolveDurablePermissionInteractionByRequestId,
  type DurablePermissionInteractionContext,
} from './pending-interaction-permission-callback.js';
import {
  findDurablePermissionInteractionByPromptMessage,
  type DurablePermissionPromptMessageContext,
} from './pending-interaction-prompt-binding.js';

const INACTIVE_FEEDBACK = 'This permission request is no longer active.';
const RETRY_FEEDBACK = 'Could not record the decision. Please retry.';

export type DurablePermissionRecoveryLocator =
  | {
      kind: 'scope';
      scope: PermissionCallbackScope;
      matchKind: PermissionCallbackClaim['match']['kind'];
      providerAlias: string;
    }
  | {
      kind: 'message';
      appId: string;
      provider: string;
      conversationId: string;
      externalMessageId: string;
      threadId?: string | null;
      providerAlias: string;
    };

export type DurablePermissionRecoveryReceipt =
  | {
      status: 'resolved';
      request: PermissionApprovalRequest;
      decision: PermissionApprovalDecision;
      context: DurablePermissionInteractionContext;
      text?: string;
    }
  | {
      status: 'expired';
      request: null;
      decision: PermissionApprovalDecision;
      text: string;
    };

export interface RecoverDurablePermissionDecisionHooks {
  locator: DurablePermissionRecoveryLocator;
  surfaceJid: string;
  incomingMode: PermissionApprovalDecisionMode;
  incomingApprover: string;
  authorize: (context: DurablePermissionInteractionContext) => Promise<boolean>;
  terminalize: (receipt: DurablePermissionRecoveryReceipt) => Promise<boolean>;
  feedback: (text: string) => Promise<void>;
}

export type DurablePermissionRecoveryOutcome =
  | 'resolved'
  | 'inactive'
  | 'wrong_surface'
  | 'unauthorized'
  | 'option_unavailable'
  | 'already_decided'
  | 'retryable';

export async function recoverDurablePermissionDecision(
  hooks: RecoverDurablePermissionDecisionHooks,
): Promise<DurablePermissionRecoveryOutcome> {
  const located = await locateDurablePermission(hooks.locator);
  if (!located) {
    await terminalizeExpired(hooks);
    await feedback(hooks, INACTIVE_FEEDBACK);
    return 'inactive';
  }
  const { durable, prompt } = located;
  if (durable.targetJid !== hooks.surfaceJid) {
    await feedback(hooks, 'This approval request belongs to a different chat.');
    return 'wrong_surface';
  }
  let authorized = false;
  try {
    authorized = await hooks.authorize(durable);
  } catch {
    await feedback(hooks, RETRY_FEEDBACK);
    return 'retryable';
  }
  if (!authorized) {
    await feedback(
      hooks,
      'You are not allowed to decide this permission request.',
    );
    return 'unauthorized';
  }
  const recoveredClaim = durable.claim ?? prompt?.claim;
  const effectiveMode = recoveredClaim?.intent.mode ?? hooks.incomingMode;
  if (!durable.decisionOptions.includes(effectiveMode)) {
    await feedback(hooks, 'This approval option is no longer available.');
    return 'option_unavailable';
  }
  const matchKind =
    recoveredClaim?.match.kind ??
    (hooks.locator.kind === 'scope'
      ? hooks.locator.matchKind
      : prompt!.matchKind);
  const expiringReviewEach =
    matchKind === 'batch' && effectiveMode === 'allow_persistent_rule';
  const claimed = await claimPermissionInteractionCallback({
    scope: durable.scope,
    mode: hooks.incomingMode,
    approverRef: hooks.incomingApprover,
    matchKind,
    providerAlias: hooks.locator.providerAlias,
    ...(recoveredClaim ? { recoveredClaim } : {}),
  });
  if (claimed.status === 'already_decided') {
    // Settlement completes BEFORE the provider card terminalizes, and
    // terminalization can fail retryably - a later tap must finish the
    // card with the SETTLED outcome instead of stranding it active. The
    // settled intent lives on the persisted claim; a review-each expiry
    // (batch claim settled as allow_persistent_rule) terminalizes as the
    // system cancel, everything else replays its recorded decision.
    const settledMode =
      expiringReviewEach || durable.reviewEachExpired
        ? 'cancel'
        : recoveredClaim?.intent.mode;
    if (!settledMode) {
      // No recoverable outcome (card already terminalized or claim gone).
      await feedback(hooks, 'This permission request was already decided.');
      return 'already_decided';
    }
    const settledDecision = {
      ...decisionForMode(
        durable.request,
        settledMode,
        expiringReviewEach || durable.reviewEachExpired
          ? 'system'
          : (recoveredClaim?.intent.approverRef ?? 'system'),
        matchKind,
      ),
      ...(recoveredClaim ? { permissionCallbackClaim: recoveredClaim } : {}),
    };
    try {
      if (
        !(await hooks.terminalize({
          status: 'resolved',
          request: durable.request,
          decision: settledDecision,
          context: durable,
        }))
      ) {
        await feedback(hooks, RETRY_FEEDBACK);
        return 'retryable';
      }
    } catch {
      await feedback(hooks, RETRY_FEEDBACK);
      return 'retryable';
    }
    await feedback(hooks, 'Decision recorded.');
    return 'resolved';
  }
  if (claimed.status === 'retryable') {
    await feedback(hooks, RETRY_FEEDBACK);
    return 'retryable';
  }
  const persistedIntent = claimed.persistedClaim ?? recoveredClaim;
  const mode = expiringReviewEach
    ? 'cancel'
    : (persistedIntent?.intent.mode ?? effectiveMode);
  const approverRef = expiringReviewEach
    ? 'system'
    : (persistedIntent?.intent.approverRef ?? hooks.incomingApprover);
  const request = durable.request;
  const decision = {
    ...decisionForMode(request, mode, approverRef, matchKind),
    permissionCallbackClaim: claimed.claim,
  };
  const resolved = await resolveDurablePermissionInteractionByRequestId({
    claim: claimed.claim,
  });
  if (!resolved) {
    await feedback(hooks, RETRY_FEEDBACK);
    return 'retryable';
  }
  try {
    if (
      !(await hooks.terminalize({
        status: 'resolved',
        request,
        decision,
        context: durable,
      }))
    ) {
      await feedback(hooks, RETRY_FEEDBACK);
      return 'retryable';
    }
  } catch {
    await feedback(hooks, RETRY_FEEDBACK);
    return 'retryable';
  }
  await feedback(hooks, 'Decision recorded.');
  return 'resolved';
}

function decisionForMode(
  request: PermissionApprovalRequest,
  mode: PermissionApprovalDecisionMode,
  decidedBy: string,
  matchKind: PermissionCallbackClaim['match']['kind'],
): PermissionApprovalDecision {
  if (
    (request.permissionBatch || matchKind === 'batch') &&
    mode === 'allow_persistent_rule'
  ) {
    return {
      approved: true,
      mode,
      decidedBy,
      reason: 'review each',
      decisionClassification: 'user_temporary',
      batchDecision: 'review_each',
    };
  }
  return domainDecisionForMode(request, mode, decidedBy);
}

async function locateDurablePermission(
  locator: DurablePermissionRecoveryLocator,
): Promise<{
  durable: DurablePermissionInteractionContext;
  prompt?: DurablePermissionPromptMessageContext;
} | null> {
  if (locator.kind === 'scope') {
    const exact = await findDurablePermissionInteractionByRequestId({
      scope: locator.scope,
      providerAlias: locator.providerAlias,
    });
    const durable =
      exact ??
      (await findDurablePermissionInteractionByRequestId({
        scope: locator.scope,
      }));
    if (
      !durable ||
      (!exact &&
        !durable.claim?.match.providerAliases.includes(locator.providerAlias))
    ) {
      return null;
    }
    return { durable };
  }
  const messageLocator = {
    appId: locator.appId,
    provider: locator.provider,
    conversationId: locator.conversationId,
    externalMessageId: locator.externalMessageId,
    ...(locator.threadId ? { threadId: locator.threadId } : {}),
  };
  const exact = await findDurablePermissionInteractionByPromptMessage({
    ...messageLocator,
    providerAlias: locator.providerAlias,
  });
  const prompt =
    exact ??
    (await findDurablePermissionInteractionByPromptMessage(messageLocator));
  if (
    !prompt ||
    (!exact &&
      !prompt.claim?.match.providerAliases.includes(locator.providerAlias))
  ) {
    return null;
  }
  const durable = await findDurablePermissionInteractionByRequestId({
    scope: prompt.scope,
  });
  return durable ? { durable, prompt } : null;
}

async function terminalizeExpired(
  hooks: RecoverDurablePermissionDecisionHooks,
): Promise<void> {
  try {
    await hooks.terminalize({
      status: 'expired',
      request: null,
      decision: {
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'expired',
      },
      text: INACTIVE_FEEDBACK,
    });
  } catch {
    // Feedback remains the visible terminal outcome when prompt editing fails.
  }
}

async function feedback(
  hooks: RecoverDurablePermissionDecisionHooks,
  text: string,
): Promise<void> {
  try {
    await hooks.feedback(text);
  } catch {
    // The provider has no second feedback channel after this hook fails.
  }
}

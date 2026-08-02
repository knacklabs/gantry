import { decisionForMode as domainDecisionForMode } from '../../domain/permission-decision.js';
import { claimPermissionInteractionCallback, findDurablePermissionInteractionByRequestId, releasePermissionInteractionCallback, resolveDurablePermissionInteractionByRequestId, } from './pending-interaction-permission-callback.js';
import { findDurablePermissionInteractionByPromptMessage, } from './pending-interaction-prompt-binding.js';
const INACTIVE_FEEDBACK = 'This permission request is no longer active.';
const RETRY_FEEDBACK = 'Could not record the decision. Please retry.';
export async function recoverDurablePermissionDecision(hooks) {
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
    }
    catch {
        await feedback(hooks, RETRY_FEEDBACK);
        return 'retryable';
    }
    if (!authorized) {
        await feedback(hooks, 'You are not allowed to decide this permission request.');
        return 'unauthorized';
    }
    const recoveredClaim = durable.claim ?? prompt?.claim;
    const effectiveMode = recoveredClaim?.intent.mode ?? hooks.incomingMode;
    if (!durable.decisionOptions.includes(effectiveMode)) {
        await feedback(hooks, 'This approval option is no longer available.');
        return 'option_unavailable';
    }
    const matchKind = recoveredClaim?.match.kind ??
        (hooks.locator.kind === 'scope'
            ? hooks.locator.matchKind
            : prompt.matchKind);
    const expiringReviewEach = matchKind === 'batch' && effectiveMode === 'allow_persistent_rule';
    const claimed = await claimPermissionInteractionCallback({
        scope: durable.scope,
        mode: hooks.incomingMode,
        approverRef: hooks.incomingApprover,
        matchKind,
        providerAlias: hooks.locator.providerAlias,
        ...(recoveredClaim ? { recoveredClaim } : {}),
    });
    if (claimed.status === 'already_decided') {
        await feedback(hooks, 'This permission request was already decided.');
        return 'already_decided';
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
        ...(request
            ? decisionForMode(request, mode, approverRef, matchKind)
            : {
                approved: mode !== 'cancel',
                mode,
                decidedBy: approverRef,
            }),
        permissionCallbackClaim: claimed.claim,
    };
    try {
        if (!(await hooks.terminalize({
            status: 'resolved',
            request: durable.request,
            decision,
            context: durable,
            ...(request
                ? {}
                : {
                    text: decision.approved
                        ? 'Permission allowed.'
                        : 'Permission cancelled.',
                }),
        }))) {
            if (!expiringReviewEach) {
                await releasePermissionInteractionCallback({ claim: claimed.claim });
            }
            await feedback(hooks, RETRY_FEEDBACK);
            return 'retryable';
        }
    }
    catch {
        if (!expiringReviewEach) {
            await releasePermissionInteractionCallback({ claim: claimed.claim });
        }
        await feedback(hooks, RETRY_FEEDBACK);
        return 'retryable';
    }
    const resolved = await resolveDurablePermissionInteractionByRequestId({
        claim: claimed.claim,
    });
    await feedback(hooks, resolved ? 'Decision recorded.' : INACTIVE_FEEDBACK);
    return resolved ? 'resolved' : 'inactive';
}
function decisionForMode(request, mode, decidedBy, matchKind) {
    if ((request.permissionBatch || matchKind === 'batch') &&
        mode === 'allow_persistent_rule') {
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
async function locateDurablePermission(locator) {
    if (locator.kind === 'scope') {
        const exact = await findDurablePermissionInteractionByRequestId({
            scope: locator.scope,
            providerAlias: locator.providerAlias,
        });
        const durable = exact ??
            (await findDurablePermissionInteractionByRequestId({
                scope: locator.scope,
            }));
        if (!durable ||
            (!exact &&
                !durable.claim?.match.providerAliases.includes(locator.providerAlias))) {
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
    const prompt = exact ??
        (await findDurablePermissionInteractionByPromptMessage(messageLocator));
    if (!prompt ||
        (!exact &&
            !prompt.claim?.match.providerAliases.includes(locator.providerAlias))) {
        return null;
    }
    const durable = await findDurablePermissionInteractionByRequestId({
        scope: prompt.scope,
    });
    return durable ? { durable, prompt } : null;
}
async function terminalizeExpired(hooks) {
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
    }
    catch {
        // Feedback remains the visible terminal outcome when prompt editing fails.
    }
}
async function feedback(hooks, text) {
    try {
        await hooks.feedback(text);
    }
    catch {
        // The provider has no second feedback channel after this hook fails.
    }
}

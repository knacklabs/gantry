import { claimPermissionInteractionCallback, DurableInteractionPersistenceError, recoverDurablePermissionDecision, recordDurableQuestionAnswerProgress, releasePermissionInteractionCallback, samePermissionCallbackLocator, } from '../application/interactions/pending-interaction-durability.js';
import { logger } from '../infrastructure/logging/logger.js';
import { decisionForMode, formatPermissionReceiptText, normalizePermissionAction, permissionDecisionOptions, } from './permission-interaction.js';
import { buildTeamsMessageCard, buildTeamsUserQuestionReceiptCard, } from './teams-cards.js';
import { formatTeamsUserQuestionReceipt, mapTeamsUserQuestionAnswers, readTeamsUserQuestionSubmit, } from './teams-user-question.js';
import { readTeamsPermissionDecision } from './teams-permission-submit.js';
import { matchesQuestionCancellation, RUNNER_CANCELLED_QUESTION_REASON, settlePendingQuestionCancellation, } from './interaction-settlement.js';
import { teamsConversationIdFromJid, } from './teams-types.js';
export function dropPendingTeamsInteraction(context, kind, request) {
    const pendingInteractions = kind === 'permission'
        ? context.pendingPermissionPrompts
        : context.pendingUserQuestions;
    for (const [providerAlias, pending] of pendingInteractions) {
        if (pending.request.requestId !== request.requestId ||
            pending.sourceAgentFolder !== request.sourceAgentFolder ||
            (pending.request.appId || 'default') !== (request.appId || 'default')) {
            continue;
        }
        pending.settled = true;
        clearTimeout(pending.timer);
        pendingInteractions.delete(providerAlias);
    }
}
export async function handleTeamsUserQuestionSubmit(input) {
    const submit = readTeamsUserQuestionSubmit(input.message.value);
    if (!submit)
        return false;
    const candidate = input.context.pendingUserQuestions.get(submit.callback.providerAlias);
    const pending = candidate && sameTeamsQuestionCallback(candidate.callback, submit.callback)
        ? candidate
        : undefined;
    if (!pending)
        return true;
    if (pending.settled)
        return true;
    const conversationId = teamsConversationIdFromJid(input.jid);
    if (!conversationId || conversationId !== pending.conversationId) {
        await sendDeniedTeamsDecisionFeedback(input.context, conversationId || teamsConversationIdFromJid(input.jid), 'This question belongs to a different chat.');
        return true;
    }
    const authorized = await canDecideTeamsPermission(input.context, input.userId, pending.sourceAgentFolder, undefined, input.jid);
    if (!authorized) {
        await sendDeniedTeamsDecisionFeedback(input.context, conversationId, 'You are not allowed to answer this question.');
        return true;
    }
    const answers = mapTeamsUserQuestionAnswers(pending.request, submit.values);
    let recorded;
    try {
        recorded = await recordDurableQuestionAnswerProgress({
            requestId: pending.request.requestId,
            appId: pending.request.appId,
            sourceAgentFolder: pending.request.sourceAgentFolder,
            answers,
            completedQuestionIndexes: pending.request.questions.flatMap((_, index) => index >= pending.callback.questionIndex ? [index] : []),
        });
    }
    catch (err) {
        throw err instanceof DurableInteractionPersistenceError
            ? err
            : new DurableInteractionPersistenceError('Teams user question answers could not be persisted', err);
    }
    if (!recorded) {
        throw new DurableInteractionPersistenceError('Teams user question answers were not persisted');
    }
    await resolvePendingTeamsUserQuestion(input.context, submit.callback.providerAlias, {
        requestId: submit.callback.scope.interactionId,
        answers,
        answeredBy: input.userName,
    });
    return true;
}
export async function resolvePendingTeamsUserQuestion(context, providerAlias, response, emptyReceiptText = 'No answer was recorded for the question.') {
    const pending = context.pendingUserQuestions.get(providerAlias);
    if (!pending || pending.settled)
        return;
    pending.settled = true;
    context.pendingUserQuestions.delete(providerAlias);
    clearTimeout(pending.timer);
    pending.resolve(response);
    const answered = Object.keys(response.answers).length > 0;
    const receiptText = answered
        ? formatTeamsUserQuestionReceipt(pending.request, response)
        : emptyReceiptText;
    if (context.sdkClient.updateAdaptiveCard && pending.messageId) {
        try {
            await context.sdkClient.updateAdaptiveCard({
                conversationId: pending.conversationId,
                messageId: pending.messageId,
                card: buildTeamsUserQuestionReceiptCard(receiptText),
            });
            return;
        }
        catch (err) {
            logger.debug({ requestId: pending.request.requestId, err }, 'Teams user question receipt card update failed; sending text');
        }
    }
    try {
        await context.sdkClient.sendMessage({
            conversationId: pending.conversationId,
            text: receiptText,
            ...(pending.threadId ? { threadId: pending.threadId } : {}),
        });
    }
    catch (err) {
        logger.debug({ requestId: pending.request.requestId, err }, 'Failed to send Teams user question receipt');
    }
}
export async function cancelPendingTeamsQuestion(context, cancellation) {
    const aliases = [...context.pendingUserQuestions]
        .filter(([, pending]) => matchesQuestionCancellation(pending.request, cancellation))
        .map(([providerAlias]) => providerAlias);
    if (aliases.length === 0)
        return 'not_found';
    const settled = await settlePendingQuestionCancellation(cancellation);
    if (settled !== 'settled')
        return settled;
    const reason = cancellation.reason ?? RUNNER_CANCELLED_QUESTION_REASON;
    for (const providerAlias of aliases) {
        const pending = context.pendingUserQuestions.get(providerAlias);
        if (!pending)
            continue;
        await resolvePendingTeamsUserQuestion(context, providerAlias, { requestId: pending.request.requestId, answers: {} }, reason);
    }
    return 'settled';
}
export async function handleTeamsPermissionDecision(input) {
    const decisionPayload = readTeamsPermissionDecision(input.message.value);
    if (!decisionPayload)
        return false;
    const pending = input.context.pendingPermissionPrompts.get(decisionPayload.callback.providerAlias);
    const mode = normalizePermissionAction(decisionPayload.decision);
    if (!pending) {
        if (mode) {
            await recoverDurablePermissionDecision({
                locator: {
                    kind: 'scope',
                    scope: decisionPayload.callback.scope,
                    matchKind: decisionPayload.callback.matchKind,
                    providerAlias: decisionPayload.callback.providerAlias,
                },
                surfaceJid: input.jid,
                incomingMode: mode,
                incomingApprover: input.userId,
                authorize: (durable) => canDecideTeamsPermission(input.context, input.userId, durable.sourceAgentFolder, durable.decisionPolicy, durable.approvalContextJid ?? '', durable.threadId ?? undefined),
                terminalize: (receipt) => terminalizeTeamsPermissionPrompt(input.context, {
                    conversationId: receipt.status === 'resolved'
                        ? (receipt.context.externalPromptConversationId ??
                            teamsConversationIdFromJid(input.jid))
                        : teamsConversationIdFromJid(input.jid),
                    messageId: receipt.status === 'resolved'
                        ? (receipt.context.externalPromptMessageId ??
                            input.message.replyToId ??
                            input.message.id)
                        : (input.message.replyToId ?? input.message.id),
                    threadId: receipt.status === 'resolved'
                        ? (receipt.context.externalPromptThreadId ??
                            receipt.context.threadId ??
                            undefined)
                        : input.message.threadId,
                    request: receipt.status === 'resolved' ? receipt.request : null,
                }, receipt.decision, receipt.status === 'expired' ? receipt.text : undefined),
                feedback: (text) => sendDeniedTeamsDecisionFeedback(input.context, teamsConversationIdFromJid(input.jid), text),
            });
        }
        return true;
    }
    if (pending.settled) {
        await sendDeniedTeamsDecisionFeedback(input.context, pending.conversationId, 'This permission request was already decided.');
        return true;
    }
    if (!samePermissionCallbackLocator(pending.callback, decisionPayload.callback)) {
        return true;
    }
    const conversationId = teamsConversationIdFromJid(input.jid);
    if (!conversationId || conversationId !== pending.conversationId) {
        logger.warn({ requestId: pending.request.requestId, jid: input.jid }, 'Teams permission decision denied: wrong channel');
        await sendDeniedTeamsDecisionFeedback(input.context, conversationId || teamsConversationIdFromJid(input.jid), 'This approval request belongs to a different chat.');
        return true;
    }
    const authorized = await canDecideTeamsPermission(input.context, input.userId, pending.sourceAgentFolder, pending.decisionPolicy, pending.approvalContextJid || input.jid, pending.threadId);
    if (!authorized) {
        logger.warn({
            requestId: pending.request.requestId,
            userId: input.userId,
            jid: input.jid,
        }, 'Teams permission decision denied: user is not a control approver');
        await sendDeniedTeamsDecisionFeedback(input.context, conversationId, 'You are not allowed to decide this permission request.');
        return true;
    }
    if (!mode)
        return true;
    if (!permissionDecisionOptions(pending.request).includes(mode)) {
        await sendDeniedTeamsDecisionFeedback(input.context, conversationId, 'This approval option is no longer available.');
        return true;
    }
    const result = await settlePendingTeamsPermission(input.context, decisionPayload.callback.providerAlias, mode, input.userId);
    if (result === 'already_decided' || result === 'ownerless') {
        await sendDeniedTeamsDecisionFeedback(input.context, conversationId, 'This permission request was already decided.');
    }
    return true;
}
export async function resolveTeamsPermissionPrompt(context, providerAlias, decision) {
    const pending = context.pendingPermissionPrompts.get(providerAlias);
    if (!pending || pending.settled)
        return false;
    if (!(await terminalizeTeamsPermissionPrompt(context, pending, decision))) {
        return false;
    }
    pending.settled = true;
    context.pendingPermissionPrompts.delete(providerAlias);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
}
export async function settlePendingTeamsPermission(context, providerAlias, mode, approverRef, reason) {
    const pending = context.pendingPermissionPrompts.get(providerAlias);
    if (!pending || pending.settled)
        return 'already_decided';
    const claimed = await claimPermissionInteractionCallback({
        scope: pending.callback.scope,
        mode,
        approverRef,
        matchKind: pending.callback.matchKind,
        providerAlias,
    });
    if (claimed.status === 'already_decided')
        return claimed.ownerless ? 'ownerless' : 'already_decided';
    if (claimed.status === 'retryable')
        return 'retryable';
    const decision = {
        ...decisionForMode(pending.request, mode, approverRef),
        ...(reason ? { reason } : {}),
        permissionCallbackClaim: claimed.claim,
    };
    if (await resolveTeamsPermissionPrompt(context, providerAlias, decision)) {
        return 'settled';
    }
    await releasePermissionInteractionCallback({ claim: claimed.claim });
    return 'retryable';
}
async function terminalizeTeamsPermissionPrompt(context, prompt, decision, receiptText) {
    const requestId = prompt.request?.requestId ??
        decision.permissionCallbackClaim?.scope.interactionId ??
        'permission';
    const resolvedReceiptText = receiptText ??
        (prompt.request
            ? formatPermissionReceiptText(requestId, prompt.request, decision)
            : decision.approved
                ? 'Permission allowed.'
                : 'Permission cancelled.');
    let updated = false;
    if (context.sdkClient.updateAdaptiveCard && prompt.messageId) {
        try {
            await context.sdkClient.updateAdaptiveCard({
                conversationId: prompt.conversationId,
                messageId: prompt.messageId,
                card: buildTeamsMessageCard({
                    text: decision.approved && decision.mode !== 'cancel'
                        ? '\u200B'
                        : resolvedReceiptText,
                    targetJid: `teams:${prompt.conversationId}`,
                    threadId: prompt.threadId,
                }),
                ...(prompt.threadId ? { threadId: prompt.threadId } : {}),
            });
            updated = true;
        }
        catch (err) {
            logger.debug({ requestId, err }, 'Failed to update Teams permission prompt; sending receipt fallback');
        }
    }
    if (!updated) {
        try {
            await context.sdkClient.sendMessage({
                conversationId: prompt.conversationId,
                text: resolvedReceiptText,
                ...(prompt.threadId ? { threadId: prompt.threadId } : {}),
            });
            return true;
        }
        catch (err) {
            logger.debug({ requestId, err }, 'Failed to send Teams permission receipt');
            return false;
        }
    }
    return true;
}
function sameTeamsQuestionCallback(left, right) {
    return (left.providerAlias === right.providerAlias &&
        left.questionIndex === right.questionIndex &&
        left.scope.appId === right.scope.appId &&
        left.scope.sourceAgentFolder === right.scope.sourceAgentFolder &&
        left.scope.interactionId === right.scope.interactionId);
}
async function canDecideTeamsPermission(context, userId, sourceAgentFolder, decisionPolicy, conversationJid, threadId) {
    if (decisionPolicy && decisionPolicy !== 'same_channel')
        return false;
    if (!context.opts.isControlApproverAllowed)
        return false;
    return context.opts.isControlApproverAllowed({
        providerId: 'teams',
        providerAccountId: context.opts.providerAccountId,
        agentId: context.opts.agentId,
        conversationJid,
        threadId,
        userId,
        sourceAgentFolder,
        decisionPolicy,
    });
}
async function sendDeniedTeamsDecisionFeedback(context, conversationId, text) {
    if (!conversationId)
        return;
    try {
        await context.sdkClient.sendMessage({ conversationId, text });
    }
    catch (err) {
        logger.debug({ conversationId, err }, 'Failed to send Teams permission denial feedback');
    }
}

import { logger } from '../../infrastructure/logging/logger.js';
import { TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS } from './channel-shared.js';
export async function disconnectTelegramDelivery(input) {
    for (const streamState of input.activeDraftStreams.values()) {
        streamState.closeStream();
    }
    input.activeDraftStreams.clear();
    input.activeGroupStreams.clear();
    input.streamGenerationByJid.clear();
    input.sealedStreamGenerationByJid.clear();
    input.activeProgressMessages.clear();
    const mediaDrained = await input.mediaIngestionQueue.waitForIdle(TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS);
    if (!mediaDrained) {
        logger.warn({ timeoutMs: TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS }, 'Timed out waiting for Telegram media ingestion queue to drain');
    }
    for (const providerAlias of input.pendingPermissionPrompts.keys()) {
        const result = await input.settlePermissionPrompt(providerAlias);
        if (result === 'already_decided')
            continue;
        const pending = input.pendingPermissionPrompts.get(providerAlias);
        if (!pending)
            continue;
        clearTimeout(pending.timer);
        input.pendingPermissionPrompts.delete(providerAlias);
        pending.resolve({
            approved: false,
            mode: 'cancel',
            decidedBy: 'system',
            reason: 'Telegram channel disconnected',
        });
    }
    for (const [key, pending] of input.pendingUserQuestions.entries()) {
        clearTimeout(pending.timer);
        pending.resolve({
            selected: pending.multiSelect
                ? [...pending.selectedOptionIndexes]
                    .sort((a, b) => a - b)
                    .map((index) => pending.optionLabels[index])
                    .filter((label) => Boolean(label))
                : '',
            answeredBy: 'system',
        });
        input.pendingUserQuestions.delete(key);
    }
    input.pendingUserQuestionCallbackIds.clear();
    if (input.bot) {
        input.bot.stop();
        await input.releasePollingLease();
        logger.info('Telegram bot stopped');
    }
    return { bot: null, draftStreamApi: null };
}
export function dropPendingTelegramInteraction(kind, request, permissions, questions, callbacks, otherPrompts) {
    const matches = (candidate) => candidate.requestId === request.requestId &&
        candidate.sourceAgentFolder === request.sourceAgentFolder &&
        (candidate.appId || 'default') === (request.appId || 'default');
    if (kind === 'permission') {
        for (const [providerAlias, pending] of permissions) {
            if (!matches(pending.request))
                continue;
            clearTimeout(pending.timer);
            permissions.delete(providerAlias);
        }
        return;
    }
    for (const [key, pending] of questions) {
        if (!matches(pending))
            continue;
        clearTimeout(pending.timer);
        questions.delete(key);
        callbacks.delete(pending.callbackId);
    }
    for (const [callbackId, target] of callbacks) {
        if (matches(target))
            callbacks.delete(callbackId);
    }
    for (const [promptId, target] of otherPrompts) {
        if (matches(target))
            otherPrompts.delete(promptId);
    }
}

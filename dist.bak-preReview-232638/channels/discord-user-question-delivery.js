import { DurableInteractionPersistenceError, recordDurableQuestionAnswerProgress, } from '../application/interactions/pending-interaction-durability.js';
import { questionComponents } from './discord-components.js';
import { discordChannelIdFromJid } from './discord-interaction-helpers.js';
import { resolveInteractionSettlementDelayMs } from './interaction-settlement.js';
export function dropPendingDiscordQuestions(pendingQuestions, request) {
    for (const pending of new Set(pendingQuestions.values())) {
        if (pending.request.requestId !== request.requestId ||
            pending.request.sourceAgentFolder !== request.sourceAgentFolder ||
            (pending.request.appId || 'default') !== (request.appId || 'default')) {
            continue;
        }
        clearTimeout(pending.timeout);
        for (const callback of pending.callbacks) {
            pendingQuestions.delete(callback.providerAlias);
        }
    }
}
export function resolvePendingDiscordQuestionsOnDisconnect(pendingQuestions) {
    for (const pending of new Set(pendingQuestions.values())) {
        clearTimeout(pending.timeout);
        pending.resolve({
            requestId: pending.request.requestId,
            answers: pending.answers,
        });
    }
    pendingQuestions.clear();
}
export async function requestDiscordUserAnswer(input) {
    const { request } = input;
    if (request.questions.length === 0) {
        return { requestId: request.requestId, answers: {} };
    }
    let resolveResponse;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
    });
    const callbacks = [];
    const deliveredQuestionIndexes = new Set();
    const pending = {
        callbacks,
        channelId: input.channelId,
        messageIds: [],
        request,
        answers: {},
        finalizedQuestions: new Set(),
        resolve: resolveResponse,
    };
    try {
        for (let questionIndex = 0; questionIndex < request.questions.length; questionIndex += 1) {
            const question = request.questions[questionIndex];
            const callback = {
                providerAlias: globalThis.crypto.randomUUID(),
                scope: {
                    appId: request.appId || 'default',
                    sourceAgentFolder: request.sourceAgentFolder,
                    interactionId: request.requestId,
                },
                questionIndex,
            };
            callbacks.push(callback);
            input.pendingQuestions.set(callback.providerAlias, pending);
            const text = [
                `Question: ${question.question}`,
                ...question.options.map((option, index) => `${index + 1}. ${option.label}: ${option.description}`),
            ].join('\n');
            const sent = await input.sendPrompt(input.jid, text, {
                threadId: request.threadId,
                components: questionComponents(request, questionIndex, callback.providerAlias),
            });
            if (sent.externalMessageId) {
                pending.messageIds.push(sent.externalMessageIds?.at(-1) ?? sent.externalMessageId);
                deliveredQuestionIndexes.add(questionIndex);
                input.onPromptDelivered?.(sent.externalMessageId, questionIndex);
            }
        }
        const { expiresAt, permissionLane } = request;
        const settlementDelayMs = resolveInteractionSettlementDelayMs({
            expiresAt,
            permissionLane,
            fallbackTimeoutMs: input.timeoutMs,
        });
        if (settlementDelayMs !== undefined) {
            pending.timeout = setTimeout(() => {
                void (async () => {
                    const remainingQuestionIndexes = [...deliveredQuestionIndexes].filter((questionIndex) => !pending.finalizedQuestions.has(questionIndex));
                    const timeoutAnswers = Object.fromEntries(remainingQuestionIndexes.map((questionIndex) => {
                        const question = request.questions[questionIndex];
                        return [
                            question.question,
                            question.multiSelect ? [] : '',
                        ];
                    }));
                    if (remainingQuestionIndexes.length > 0) {
                        const recorded = await recordDurableQuestionAnswerProgress({
                            requestId: request.requestId,
                            appId: request.appId,
                            sourceAgentFolder: request.sourceAgentFolder,
                            answers: timeoutAnswers,
                            completedQuestionIndexes: remainingQuestionIndexes,
                        });
                        if (!recorded) {
                            throw new DurableInteractionPersistenceError('Discord user question timeout was not persisted');
                        }
                    }
                    for (const callback of callbacks) {
                        input.pendingQuestions.delete(callback.providerAlias);
                    }
                    resolveResponse({
                        requestId: request.requestId,
                        answers: { ...pending.answers, ...timeoutAnswers },
                    });
                })().catch((err) => {
                    rejectResponse(err instanceof DurableInteractionPersistenceError
                        ? err
                        : new DurableInteractionPersistenceError('Discord user question timeout could not be persisted', err));
                });
            }, settlementDelayMs);
            pending.timeout.unref?.();
        }
    }
    catch (err) {
        clearTimeout(pending.timeout);
        for (const callback of callbacks) {
            input.pendingQuestions.delete(callback.providerAlias);
        }
        if (err instanceof DurableInteractionPersistenceError)
            throw err;
        return { requestId: request.requestId, answers: {} };
    }
    return response;
}
export function createDiscordUserQuestionRequester(input) {
    return async (jid, request, onPromptDelivered) => {
        const channelId = request.threadId || discordChannelIdFromJid(jid);
        if (!channelId) {
            return { requestId: request.requestId, answers: {} };
        }
        return requestDiscordUserAnswer({
            ...input,
            jid,
            channelId,
            request,
            onPromptDelivered,
        });
    };
}

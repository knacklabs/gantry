import { type DurableQuestionCallback } from '../application/interactions/pending-interaction-durability.js';
import type { MessageDeliveryResult, UserQuestionRequest, UserQuestionResponse } from '../domain/types.js';
export interface PendingDiscordQuestion {
    callbacks: DurableQuestionCallback[];
    channelId: string;
    messageIds: string[];
    request: UserQuestionRequest;
    answers: Record<string, string | string[]>;
    finalizedQuestions: Set<number>;
    resolve: (response: UserQuestionResponse) => void;
    timeout?: ReturnType<typeof setTimeout>;
}
export declare function dropPendingDiscordQuestions(pendingQuestions: Map<string, PendingDiscordQuestion>, request: Pick<UserQuestionRequest, 'appId' | 'sourceAgentFolder' | 'requestId'>): void;
export declare function resolvePendingDiscordQuestionsOnDisconnect(pendingQuestions: Map<string, PendingDiscordQuestion>): void;
export declare function requestDiscordUserAnswer(input: {
    jid: string;
    channelId: string;
    request: UserQuestionRequest;
    pendingQuestions: Map<string, PendingDiscordQuestion>;
    sendPrompt: (jid: string, text: string, options: {
        threadId?: string;
        components?: unknown[];
    }) => Promise<MessageDeliveryResult>;
    timeoutMs: number;
    onPromptDelivered?: (messageId: string, questionIndex?: number) => void;
}): Promise<UserQuestionResponse>;
export declare function createDiscordUserQuestionRequester(input: {
    pendingQuestions: Map<string, PendingDiscordQuestion>;
    sendPrompt: (jid: string, text: string, options: {
        threadId?: string;
        components?: unknown[];
    }) => Promise<MessageDeliveryResult>;
    timeoutMs: number;
}): (jid: string, request: UserQuestionRequest, onPromptDelivered?: (messageId: string, questionIndex?: number) => void) => Promise<UserQuestionResponse>;

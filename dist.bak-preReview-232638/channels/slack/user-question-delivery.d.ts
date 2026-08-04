import type { App } from '@slack/bolt';
import type { UserQuestionRequest, UserQuestionResponse } from '../../domain/types.js';
import type { PendingUserQuestionState } from './channel-state.js';
import { type DurableQuestionCallback } from '../../application/interactions/pending-interaction-durability.js';
export declare function requestSlackUserAnswer(input: {
    app: App;
    channelId: string;
    request: UserQuestionRequest;
    timeoutMs: number;
    pendingUserQuestions: Map<string, PendingUserQuestionState>;
    pendingUserQuestionKey: (callback: DurableQuestionCallback) => string;
    formatPromptText: (request: UserQuestionRequest, question: UserQuestionRequest['questions'][number], timeoutMs: number) => string;
    buildBlocks: (pending: PendingUserQuestionState) => Array<Record<string, unknown>>;
    finalizeTimedOut: (pending: PendingUserQuestionState) => Promise<void>;
    onPromptDelivered?: (messageId: string, questionIndex?: number) => void;
}): Promise<UserQuestionResponse>;

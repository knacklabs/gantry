import type { App } from '@slack/bolt';
import type { DurableQuestionCallback } from '../../application/interactions/pending-interaction-durability.js';
import type { PendingUserQuestionState } from './channel-state.js';
type ParsedUserQuestionAction = {
    callback: DurableQuestionCallback;
    optionIndex?: number;
};
export declare function registerSlackUserQuestionHandlers(input: {
    app: App;
    pendingUserQuestions: Map<string, PendingUserQuestionState>;
    parseActionValue: (value: string | undefined) => ParsedUserQuestionAction | null;
    pendingKey: (callback: DurableQuestionCallback) => string;
    canAnswer: (userId: string, sourceAgentFolder: string, conversationJid: string) => Promise<boolean>;
    refreshPrompt: (pending: PendingUserQuestionState) => Promise<void>;
    finalizePrompt: (pending: PendingUserQuestionState, selection: string | string[], answeredBy?: string) => Promise<void>;
}): void;
export {};

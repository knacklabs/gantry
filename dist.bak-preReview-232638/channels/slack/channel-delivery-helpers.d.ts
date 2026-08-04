import { App } from '@slack/bolt';
import { MessageDeliveryResult, MessageSendOptions, OnChatMetadata, ProgressUpdateOptions } from '../../domain/types.js';
import { ActiveProgressState, ActiveStreamState, PendingUserQuestionState } from './channel-state.js';
type SlackPostMessagePayload = {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: Array<Record<string, unknown>>;
};
type SlackDeliveryLogger = {
    warn(metadata: Record<string, unknown>, message: string): void;
};
export type SlackSnippetFallbackInput = {
    channelId: string;
    text: string;
    threadId?: string;
    reason: string;
};
export type SlackSnippetFallbackResult = {
    fallbackArtifactId: string;
    externalMessageId?: string;
};
export declare function isSlackPayloadTooLarge(err: unknown): boolean;
export declare function postSlackMessageWithRetry(app: App | null, payload: SlackPostMessagePayload, context: {
    jid: string;
    part: number;
    totalParts: number;
}, warnings: string[], log: SlackDeliveryLogger): Promise<{
    ts?: string;
}>;
export declare function sendSlackMessage(input: {
    app: App | null;
    jid: string;
    channelId: string;
    formattedText: string;
    options: MessageSendOptions;
    log: SlackDeliveryLogger;
    sendSnippetFallback: (fallback: SlackSnippetFallbackInput) => Promise<SlackSnippetFallbackResult | null>;
}): Promise<MessageDeliveryResult | void>;
export declare function sendSlackFallbackStreamParts(input: {
    app: App | null;
    jid: string;
    state: ActiveStreamState;
    fallbackParts: string[];
    log: SlackDeliveryLogger;
    shouldContinue: () => boolean;
}): Promise<void>;
export declare function sendSlackProgressUpdate(input: {
    app: App | null;
    channelId: string;
    key: string;
    text: string;
    options: ProgressUpdateOptions;
    activeProgress: Map<string, ActiveProgressState>;
    persistProgress: () => void;
}): Promise<void>;
export declare function loadPersistedSlackProgress(botToken: string, activeProgress: Map<string, ActiveProgressState>): void;
export declare function persistSlackProgress(botToken: string, activeProgress: Map<string, ActiveProgressState>): void;
export declare function resolveSlackDisconnectQuestions(input: {
    pendingUserQuestions: Map<string, PendingUserQuestionState>;
}): void;
export declare function disconnectSlackDelivery(input: {
    app: App | null;
    activeStreams: Map<string, ActiveStreamState>;
    streamGenerationByJid: Map<string, number>;
    sealedStreamGenerationByJid: Map<string, number>;
    activeProgress: Map<string, ActiveProgressState>;
    pendingUserQuestions: Map<string, PendingUserQuestionState>;
    stopNativeStream: (channelId: string, streamTs: string) => Promise<boolean>;
}): Promise<App | null>;
export declare function syncSlackGroups(input: {
    app: App | null;
    force: boolean;
    channelNameCache: Map<string, string>;
    resolveChannelName: (channelId: string) => Promise<string>;
    onChatMetadata: OnChatMetadata;
    providerAccountId?: string;
}): Promise<void>;
export {};

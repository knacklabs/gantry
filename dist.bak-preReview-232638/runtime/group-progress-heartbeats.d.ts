import type { MessageSendOptions, ProgressUpdateOptions } from '../domain/types.js';
type GroupProgressHeartbeatLogger = {
    debug(metadata: Record<string, unknown>, message: string): void;
    info?(metadata: Record<string, unknown>, message: string): void;
};
export declare function startInitialGroupProgress(input: {
    supportsProgress: boolean;
    groupName: string;
    buildProgressOptions: () => ProgressUpdateOptions | undefined;
    sendProgressToChannel(text: string, options?: ProgressUpdateOptions): Promise<void>;
    onSent?: () => Promise<void> | void;
    log: GroupProgressHeartbeatLogger;
}): {
    cancel(): Promise<void>;
};
export declare function createResponseProgressSenders(input: {
    supportsProgress: boolean;
    activeThreadId?: string;
    progressGeneration?: () => number | undefined;
    buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
    sendMessageToChannel(text: string, options?: MessageSendOptions): Promise<void>;
    sendProgressToChannel(text: string, options?: ProgressUpdateOptions): Promise<void>;
}): {
    sendWaitingProgress: () => Promise<void>;
    sendResponseReceipt: () => Promise<void>;
};
export declare function startGroupProgressHeartbeats(input: {
    supportsProgress: boolean;
    isTypingActive: () => boolean;
    chatJid: string;
    providerAccountId?: string;
    groupName: string;
    channelRuntime: {
        setTyping(jid: string, isTyping: boolean, options?: {
            providerAccountId?: string;
        }): Promise<void>;
    };
    log: GroupProgressHeartbeatLogger;
}): {
    typingHeartbeatTimer: ReturnType<typeof setInterval>;
    pause(): void;
    resume(): void;
};
export {};

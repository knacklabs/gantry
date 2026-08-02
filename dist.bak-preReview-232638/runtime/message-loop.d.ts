import { NewMessage, ProgressUpdateOptions, ConversationRoute } from '../domain/types.js';
import type { RuntimeConversationRouteRepository, RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import type { LiveAdmissionWorkItem } from '../domain/ports/live-turns.js';
import type { SessionCommand } from '../session/session-commands.js';
export interface MessageLoopDeps {
    getConversationRoutes: () => Record<string, ConversationRoute>;
    getOrRecoverCursor: (chatJid: string) => Promise<string> | string;
    setAgentCursor: (chatJid: string, timestamp: string) => void;
    saveState: () => Promise<void> | void;
    hasChannel: (chatJid: string, options?: {
        providerAccountId?: string;
    }) => boolean;
    setTyping: (chatJid: string, isTyping: boolean, options?: {
        providerAccountId?: string;
    }) => Promise<void>;
    sendProgressUpdate: (chatJid: string, text: string, options?: ProgressUpdateOptions) => Promise<void>;
    queue: {
        sendMessage: (chatJid: string, text: string, options?: {
            threadId?: string | null;
            senderUserIds?: readonly string[] | null;
            idempotencyKey?: string;
            cursorAfter?: string;
        }) => boolean | Promise<boolean>;
        enqueueMessageCheck: (chatJid: string) => void | boolean | Promise<void | boolean>;
        closeStdin: (chatJid: string) => void | Promise<void>;
        stopGroup?: (chatJid: string) => boolean | Promise<boolean>;
    };
    handleActiveControlCommand?: (args: {
        chatJid: string;
        queueJid: string;
        group: ConversationRoute;
        message: NewMessage;
        command: SessionCommand;
    }) => Promise<boolean> | boolean;
    opsRepository?: RuntimeMessageRepository & Partial<RuntimeConversationRouteRepository>;
}
export type MessageAdmissionProcessingResult = 'completed' | 'queued_capacity' | 'listener_degraded';
export declare function processLiveAdmissionWorkItem(deps: MessageLoopDeps, item: LiveAdmissionWorkItem): Promise<MessageAdmissionProcessingResult>;
export declare function recoverPendingMessages(deps: MessageLoopDeps): Promise<void>;

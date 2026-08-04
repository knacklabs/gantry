import type { MessageSendOptions, NewMessage } from '../../domain/types.js';
import { type SessionCommand } from '../../session/session-commands.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type { LiveTurnAuthority } from '../../runtime/live-turn-authority.js';
import { type LiveTurnScopeRepository } from './live-recovery-coordinator.js';
type ActiveCompactHandler = (args: {
    chatJid: string;
    queueJid: string;
    group: {
        folder: string;
        trigger?: string;
        conversationKind?: 'dm' | 'channel';
        providerAccountId?: string;
    };
    message: NewMessage;
    command: SessionCommand;
}) => Promise<boolean> | boolean;
export declare function handleActiveCompactRouteMessage(input: {
    message: NewMessage;
    route: {
        folder: string;
        trigger?: string;
        conversationKind?: 'dm' | 'channel';
        providerAccountId?: string;
    };
    chatJid: string;
    queueJid: string;
    handleActiveControlCommand?: ActiveCompactHandler;
}): Promise<boolean>;
export declare function isActiveCompactRouteMessage(input: {
    message: NewMessage;
    route: {
        folder: string;
        trigger?: string;
    };
    chatJid: string;
    handleActiveControlCommand?: ActiveCompactHandler;
}): boolean;
export declare function createActiveCompactRouteHandlers(input: {
    route: {
        folder: string;
        trigger?: string;
        conversationKind?: 'dm' | 'channel';
        providerAccountId?: string;
    };
    chatJid: string;
    queueJid: string;
    handleActiveControlCommand?: ActiveCompactHandler;
}): {
    isActiveControlMessage: (message: NewMessage) => boolean;
    handleActiveControlMessage: (message: NewMessage) => Promise<boolean>;
};
export declare function queueActiveCompaction(input: {
    hasActiveTurn: boolean;
    findActiveLiveTurn: () => Promise<boolean>;
    enqueueMessageCheck: () => void;
    sendQueuedReceipt: () => Promise<void>;
    receiptDedupeKey?: string;
}): Promise<boolean>;
export declare function queueActiveCompactionForRuntime(input: {
    hasActiveTurn: boolean;
    liveTurnAuthority: LiveTurnAuthority | undefined;
    app: {
        queue: {
            enqueueMessageCheck(queueJid: string): boolean;
        };
        getConversationRoutes(): Record<string, {
            folder: string;
            conversationKind?: 'channel' | 'dm';
            agentConfig?: {
                model?: string;
            };
        }>;
    };
    opsRepository: LiveTurnScopeRepository;
    executionAdapter: {
        id: ExecutionProviderId;
    };
    queueJid: string;
    message?: Pick<NewMessage, 'id' | 'timestamp'>;
    sendQueuedReceipt: () => Promise<void>;
}): Promise<boolean>;
type ActiveControlReceiptInput = {
    sendMessage: (text: string, options: {
        durability: 'required';
        messageOptions?: MessageSendOptions;
    }) => Promise<void>;
    threadId?: string;
    providerAccountId?: string;
};
export declare function sendActiveControlReceipt(input: ActiveControlReceiptInput & {
    text: string;
}): Promise<void>;
export declare function sendActiveCompactionQueuedReceipt(input: ActiveControlReceiptInput): Promise<void>;
export {};

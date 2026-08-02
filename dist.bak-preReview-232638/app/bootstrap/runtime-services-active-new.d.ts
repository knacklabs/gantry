import type { NewMessage } from '../../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../../domain/repositories/ops-repo.js';
import type { SessionMemoryCollector } from '../../domain/ports/session-memory-collector.js';
import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { ChannelWiring } from './channel-wiring-types.js';
export declare function controlAckMessageOptions(threadId?: string, providerAccountId?: string): {
    threadId?: string;
    providerAccountId?: string;
} | undefined;
export declare function handleActiveNewSessionCommand(input: {
    app: {
        queue: {
            stopGroup(queueKey: string): boolean;
        };
        clearSessionForChatJid(chatJid: string, threadId?: string | null, metadata?: {
            memoryUserId?: string;
            providerAccountId?: string | null;
        }): Promise<void>;
        setAgentCursor(queueKey: string, cursor: string): void;
        saveState(): Promise<void>;
    };
    channelWiring: Pick<ChannelWiring, 'sendMessage'>;
    opsRepository: RuntimeAgentSessionRepository;
    collectSessionMemory: SessionMemoryCollector;
    logger: {
        warn(payload: unknown, message: string): void;
    };
    group: {
        folder: string;
        conversationKind?: 'dm' | 'channel';
        providerAccountId?: string;
    };
    executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
    chatJid: string;
    queueJid: string;
    threadId?: string;
    message: NewMessage;
}): Promise<boolean>;

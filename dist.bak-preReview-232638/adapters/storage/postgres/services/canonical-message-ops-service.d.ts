import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import type { LiveAdmissionWorkItemEnqueueResult, LiveAdmissionWorkItemNotifier } from '../../../../domain/ports/live-turns.js';
import type { MessageLiveAdmissionInput, PostgresCanonicalMessageRepository } from '../repositories/canonical-message-repository.postgres.js';
export declare class CanonicalMessageOpsService {
    private readonly repository;
    private readonly liveAdmissionNotifier?;
    constructor(repository: PostgresCanonicalMessageRepository, liveAdmissionNotifier?: LiveAdmissionWorkItemNotifier | undefined);
    storeMessage(msg: NewMessage): Promise<void>;
    storeMessageWithLiveAdmission(msg: NewMessage, admission: MessageLiveAdmissionInput): Promise<LiveAdmissionWorkItemEnqueueResult | undefined>;
    notifyLiveAdmissionWorkItem(result: LiveAdmissionWorkItemEnqueueResult): Promise<void>;
    getMessagesSince(chatJid: string, sinceCursor: string, limit?: number, options?: {
        threadId?: string | null;
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getContextMessagesSince(chatJid: string, sinceCursor: string, limit?: number, options?: {
        threadId?: string | null;
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getRecentTopLevelMessagesBefore(chatJid: string, before: Pick<NewMessage, 'timestamp' | 'id'>, limit?: number, options?: {
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getFirstThreadMessages(chatJid: string, threadId: string, limit?: number, options?: {
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getLatestThreadMessages(chatJid: string, threadId: string, beforeOrAt: Pick<NewMessage, 'timestamp' | 'id'>, limit?: number, options?: {
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getMessageThreadIds(chatJid: string, options?: {
        providerAccountId?: string | null;
    }): Promise<Array<string | null>>;
    getLastBotMessageCursor(chatJid: string, options?: {
        providerAccountId?: string | null;
    }): Promise<{
        timestamp: string;
        id: string;
    } | undefined>;
    getLastBotMessageTimestamp(chatJid: string, options?: {
        providerAccountId?: string | null;
    }): Promise<string | undefined>;
    private mapMessage;
}

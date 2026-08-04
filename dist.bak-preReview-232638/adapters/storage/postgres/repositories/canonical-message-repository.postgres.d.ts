import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../../../domain/ports/live-turns.js';
import { type CanonicalDb, type CanonicalExecutor } from './canonical-graph-repository.postgres.js';
export { externalRefForMessage, messageIdFor, } from './canonical-message-repository-identifiers.js';
export interface CanonicalOpsMessageRow {
    id: string;
    conversation_id: string;
    thread_id: string | null;
    external_ref_json: string | null;
    direction: string;
    sender_user_id: string | null;
    sender_display_name: string | null;
    trust: string;
    created_at: string;
    received_at: string | null;
    delivery_status: string | null;
    delivered_at: string | null;
    delivery_error: string | null;
    payload_json: string | null;
    attachments_json?: string | null;
}
export interface MessageLiveAdmissionInput {
    appId: string;
    agentId?: string | null;
    agentSessionId?: string | null;
    providerAccountId?: string | null;
    triggerDecision?: Record<string, unknown>;
    now?: string;
}
interface MessageListInput {
    jids: string[];
    providerAccountId?: string | null;
    after?: {
        timestamp: string;
        chatJid: string;
        id: string;
    };
    before?: {
        timestamp: string;
        chatJid: string;
        id: string;
    };
    beforeOrAt?: {
        timestamp: string;
        chatJid: string;
        id: string;
    };
    threadId?: string | null;
    hasThreadFilter?: boolean;
    includeSelfThreadRoots?: boolean;
    limit?: number;
    order?: 'asc' | 'desc';
}
export declare class PostgresCanonicalMessageRepository {
    private readonly db;
    private readonly maxLiveAdmissionBacklog;
    private readonly graph;
    constructor(db: CanonicalDb, maxLiveAdmissionBacklog?: number);
    saveMessage(msg: NewMessage, options?: {
        liveAdmission?: MessageLiveAdmissionInput;
    }): Promise<LiveAdmissionWorkItemEnqueueResult | undefined>;
    saveMessageWithExecutor(tx: CanonicalExecutor, msg: NewMessage, options?: {
        liveAdmission?: MessageLiveAdmissionInput;
    }): Promise<LiveAdmissionWorkItemEnqueueResult | undefined>;
    listInboundMessages(input: MessageListInput): Promise<CanonicalOpsMessageRow[]>;
    listContextMessages(input: MessageListInput): Promise<CanonicalOpsMessageRow[]>;
    private listMessages;
    listThreadIds(chatJid: string, options?: {
        providerAccountId?: string | null;
    }): Promise<Array<string | null>>;
    getLastBotMessageRow(chatJid: string, options?: {
        providerAccountId?: string | null;
    }): Promise<CanonicalOpsMessageRow | undefined>;
}

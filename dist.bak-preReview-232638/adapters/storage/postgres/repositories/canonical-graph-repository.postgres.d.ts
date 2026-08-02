import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ChatInfo } from '../../../../domain/repositories/domain-types.js';
import * as pgSchema from '../schema/schema.js';
export declare const CANONICAL_APP_ID = "default";
export declare const DEFAULT_LLM_PROFILE_ID = "llm:default";
export type CanonicalDb = NodePgDatabase<typeof pgSchema>;
export type CanonicalTx = Parameters<Parameters<CanonicalDb['transaction']>[0]>[0];
export type CanonicalExecutor = CanonicalDb | CanonicalTx;
export interface CanonicalConversationRow {
    id: string;
    externalRefJson: string | null;
    title: string | null;
    kind: string;
    updatedAt: string;
    createdAt: string;
    providerId: string;
}
export declare function providerIdForJid(jid: string): string;
export declare function externalConversationIdForJid(jid: string): string;
export declare function conversationIdForJid(jid: string, providerAccountId?: string | null): string;
export declare function agentIdForFolder(folder: string): string;
export declare function configVersionIdForAgent(agentId: string): string;
export declare function threadIdFor(chatJid: string, threadId?: string | null, providerAccountId?: string | null): string | null;
export declare function canonicalProviderThreadForIds<AppId extends string, ConversationId extends string>(input: {
    appId: AppId;
    conversationId: ConversationId | null | undefined;
    threadId: string | null | undefined;
}): {
    id: string;
    appId: AppId;
    conversationId: ConversationId;
    externalRefJson: string;
} | null;
export declare function json(value: unknown): string;
export declare function jsonb(value: unknown): unknown;
export declare function jsonText(value: unknown): string;
export declare function parseJson<T>(value: unknown, fallback: T): T;
export declare class PostgresCanonicalGraphRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    ensureApp(executor?: CanonicalExecutor): Promise<void>;
    ensureAgent(folder: string, name?: string, executor?: CanonicalExecutor): Promise<string>;
    ensureAgentExists(folder: string, name?: string, executor?: CanonicalExecutor): Promise<string>;
    ensureConversation(jid: string, input?: {
        name?: string | null;
        channel?: string | null;
        agentFolder?: string | null;
        existingConversationId?: string | null;
        isGroup?: boolean | null;
        timestamp?: string | null;
        providerAccountId?: string | null;
    }, executor?: CanonicalExecutor): Promise<string>;
    ensureThread(chatJid: string, threadId?: string | null, executor?: CanonicalExecutor, input?: {
        channel?: string | null;
        providerAccountId?: string | null;
    }): Promise<string | null>;
    ensureParticipant(input: {
        conversationId: string;
        providerId: string;
        providerAccountId: string;
        externalUserId: string;
        displayName?: string | null;
        timestamp?: string | null;
    }, executor?: CanonicalExecutor): Promise<string | null>;
    listChats(): Promise<ChatInfo[]>;
    getConversationInstallationId(conversationId: string, executor?: CanonicalExecutor): Promise<string | undefined>;
    findConversationIdForJid(jid: string, executor?: CanonicalExecutor): Promise<string | undefined>;
    listConversationIds(): Promise<string[]>;
}

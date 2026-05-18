import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ChatInfo } from '../../../../domain/repositories/domain-types.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import {
  normalizeProviderId,
  providerIdForJid as resolveProviderIdForJid,
} from '../../../../channels/provider-registry.js';
import * as pgSchema from '../schema/schema.js';

export const CANONICAL_APP_ID = 'default';
export const DEFAULT_LLM_PROFILE_ID = 'llm:default';

export type CanonicalDb = NodePgDatabase<typeof pgSchema>;
export type CanonicalTx = Parameters<
  Parameters<CanonicalDb['transaction']>[0]
>[0];
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

export function providerIdForJid(jid: string): string {
  return resolveProviderIdForJid(jid);
}

export function externalConversationIdForJid(jid: string): string {
  const idx = jid.indexOf(':');
  return idx > 0 ? jid.slice(idx + 1) : jid;
}

export function conversationIdForJid(jid: string): string {
  return `conversation:${jid}`;
}

export function agentIdForFolder(folder: string): string {
  return `agent:${folder}`;
}

export function configVersionIdForAgent(agentId: string): string {
  return `config:${agentId}:1`;
}

export function threadIdFor(
  chatJid: string,
  threadId?: string | null,
): string | null {
  const normalized = threadId?.trim();
  return normalized ? `thread:${chatJid}:${normalized}` : null;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function jsonb(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  if (value.length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch (err) {
    throw new Error(
      `Invalid JSON string passed to jsonb column writer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  if (value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class PostgresCanonicalGraphRepository {
  constructor(private readonly db: CanonicalDb) {}

  async ensureApp(executor: CanonicalExecutor = this.db): Promise<void> {
    await executor
      .insert(pgSchema.appsPostgres)
      .values({
        id: CANONICAL_APP_ID,
        slug: 'personal',
        name: 'Default Personal App',
      })
      .onConflictDoNothing();
    await executor
      .insert(pgSchema.llmProfilesPostgres)
      .values({
        id: DEFAULT_LLM_PROFILE_ID,
        appId: CANONICAL_APP_ID,
        purpose: 'default',
        modelAlias: 'default',
      })
      .onConflictDoNothing();
  }

  async ensureAgent(
    folder: string,
    name: string = folder,
    executor: CanonicalExecutor = this.db,
  ): Promise<string> {
    await this.ensureApp(executor);
    const agentId = agentIdForFolder(folder);
    const configVersionId = configVersionIdForAgent(agentId);
    await executor
      .insert(pgSchema.agentsPostgres)
      .values({
        id: agentId,
        appId: CANONICAL_APP_ID,
        name,
        status: 'active',
        currentConfigVersionId: configVersionId,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentsPostgres.id,
        set: {
          name,
          currentConfigVersionId: configVersionId,
          updatedAt: sql`now()`,
        },
      });
    await executor
      .insert(pgSchema.agentConfigVersionsPostgres)
      .values({
        id: configVersionId,
        appId: CANONICAL_APP_ID,
        agentId,
        version: 1,
        promptProfileRef: 'default',
        llmProfileId: DEFAULT_LLM_PROFILE_ID,
      })
      .onConflictDoNothing();
    return agentId;
  }

  async ensureAgentExists(
    folder: string,
    name: string = folder,
    executor: CanonicalExecutor = this.db,
  ): Promise<string> {
    await this.ensureApp(executor);
    const agentId = agentIdForFolder(folder);
    const configVersionId = configVersionIdForAgent(agentId);
    await executor
      .insert(pgSchema.agentsPostgres)
      .values({
        id: agentId,
        appId: CANONICAL_APP_ID,
        name,
        status: 'active',
        currentConfigVersionId: configVersionId,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentsPostgres.id,
        set: {
          currentConfigVersionId: configVersionId,
          updatedAt: sql`now()`,
        },
      });
    await executor
      .insert(pgSchema.agentConfigVersionsPostgres)
      .values({
        id: configVersionId,
        appId: CANONICAL_APP_ID,
        agentId,
        version: 1,
        promptProfileRef: 'default',
        llmProfileId: DEFAULT_LLM_PROFILE_ID,
      })
      .onConflictDoNothing();
    return agentId;
  }

  async ensureConversation(
    jid: string,
    input: {
      name?: string | null;
      channel?: string | null;
      isGroup?: boolean | null;
      timestamp?: string | null;
    } = {},
    executor: CanonicalExecutor = this.db,
  ): Promise<string> {
    await this.ensureApp(executor);
    const providerId =
      normalizeProviderId(input.channel || providerIdForJid(jid)) || 'app';
    const providerConnectionId = `channel-providerConnection:${CANONICAL_APP_ID}:${providerId}`;
    const conversationId = conversationIdForJid(jid);
    const title = input.name || jid;
    const now = input.timestamp || currentIso();
    const hasKnownKind = input.isGroup !== undefined && input.isGroup !== null;
    const externalConversationId = externalConversationIdForJid(jid);
    const externalRefJson = json({
      kind: 'conversation',
      value: externalConversationId,
      jid,
      providerId,
      externalConversationId,
      ...(hasKnownKind ? { isGroup: Boolean(input.isGroup) } : {}),
    });
    await executor
      .insert(pgSchema.providersPostgres)
      .values({ id: providerId, displayName: providerId })
      .onConflictDoNothing();
    await executor
      .insert(pgSchema.providerConnectionsPostgres)
      .values({
        id: providerConnectionId,
        appId: CANONICAL_APP_ID,
        providerId,
        label: providerId,
      })
      .onConflictDoNothing();
    await executor
      .insert(pgSchema.conversationsPostgres)
      .values({
        id: conversationId,
        appId: CANONICAL_APP_ID,
        providerConnectionId: providerConnectionId,
        externalRefJson,
        kind: input.isGroup ? 'group' : 'direct',
        title,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgSchema.conversationsPostgres.id,
        set: {
          ...(input.name ? { title } : {}),
          ...(hasKnownKind ? { kind: input.isGroup ? 'group' : 'direct' } : {}),
          externalRefJson,
          updatedAt: sql`GREATEST(${pgSchema.conversationsPostgres.updatedAt}, ${now})`,
        },
      });
    return conversationId;
  }

  async ensureThread(
    chatJid: string,
    threadId?: string | null,
    executor: CanonicalExecutor = this.db,
    input: { channel?: string | null } = {},
  ): Promise<string | null> {
    const canonicalThreadId = threadIdFor(chatJid, threadId);
    if (!canonicalThreadId) return null;
    const conversationId = await this.ensureConversation(
      chatJid,
      { channel: input.channel },
      executor,
    );
    await executor
      .insert(pgSchema.conversationThreadsPostgres)
      .values({
        id: canonicalThreadId,
        appId: CANONICAL_APP_ID,
        conversationId,
        externalRefJson: json({
          kind: 'conversation_thread',
          value: threadId,
          jid: chatJid,
          threadId,
          externalThreadId: threadId,
        }),
      })
      .onConflictDoNothing();
    return canonicalThreadId;
  }

  async ensureParticipant(
    input: {
      conversationId: string;
      providerId: string;
      providerConnectionId: string;
      externalUserId: string;
      displayName?: string | null;
      timestamp?: string | null;
    },
    executor: CanonicalExecutor = this.db,
  ): Promise<string | null> {
    const externalUserId = input.externalUserId.trim();
    if (!externalUserId) return null;
    const safeProvider = input.providerId.replace(/[^a-zA-Z0-9._:-]/g, '_');
    const safeUser = externalUserId.replace(/[^a-zA-Z0-9._:-]/g, '_');
    const userId = `user:${CANONICAL_APP_ID}:${safeProvider}:${safeUser}`;
    const aliasId = `user-alias:${CANONICAL_APP_ID}:${safeProvider}:${input.providerConnectionId}:${safeUser}`;
    const participantId = `participant:${input.conversationId}:${safeUser}`;
    const now = input.timestamp || currentIso();
    const displayName = input.displayName
      ? `${input.displayName} (${input.providerId}:${externalUserId})`
      : `${input.providerId}:${externalUserId}`;
    await executor
      .insert(pgSchema.usersPostgres)
      .values({
        id: userId,
        appId: CANONICAL_APP_ID,
        kind: 'human',
        displayName,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgSchema.usersPostgres.id,
        set: {
          displayName,
          updatedAt: now,
        },
      });
    await executor
      .insert(pgSchema.userAliasesPostgres)
      .values({
        id: aliasId,
        appId: CANONICAL_APP_ID,
        userId,
        provider: input.providerId,
        providerConnectionId: input.providerConnectionId,
        externalUserId,
        displayName: input.displayName ?? externalUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgSchema.userAliasesPostgres.id,
        set: {
          userId,
          displayName: input.displayName ?? externalUserId,
          updatedAt: now,
        },
      });
    await executor
      .insert(pgSchema.conversationParticipantsPostgres)
      .values({
        id: participantId,
        appId: CANONICAL_APP_ID,
        conversationId: input.conversationId,
        userId,
        externalUserId,
        role: 'member',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgSchema.conversationParticipantsPostgres.id,
        set: {
          userId,
          externalUserId,
          status: 'active',
          updatedAt: now,
        },
      });
    return userId;
  }

  async listChats(): Promise<ChatInfo[]> {
    const c = pgSchema.conversationsPostgres;
    const ci = pgSchema.providerConnectionsPostgres;
    const rows = await this.db
      .select({
        id: c.id,
        externalRefJson: c.externalRefJson,
        title: c.title,
        kind: c.kind,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        providerId: ci.providerId,
      })
      .from(c)
      .innerJoin(ci, eq(ci.id, c.providerConnectionId))
      .orderBy(sql`${c.updatedAt} DESC`);
    return rows.map((row) => {
      const ref = parseJson<{ jid?: string }>(row.externalRefJson, {});
      return {
        jid: ref.jid || row.id,
        name: row.title || ref.jid || row.id,
        last_message_time: row.updatedAt,
        channel: row.providerId || '',
        is_group: row.kind === 'group' || row.kind === 'channel' ? 1 : 0,
      };
    });
  }

  async getConversationInstallationId(
    conversationId: string,
    executor: CanonicalExecutor = this.db,
  ): Promise<string | undefined> {
    const rows = await executor
      .select({
        providerConnectionId:
          pgSchema.conversationsPostgres.providerConnectionId,
      })
      .from(pgSchema.conversationsPostgres)
      .where(eq(pgSchema.conversationsPostgres.id, conversationId))
      .limit(1);
    return rows[0]?.providerConnectionId;
  }

  async listConversationIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: pgSchema.conversationsPostgres.id })
      .from(pgSchema.conversationsPostgres)
      .orderBy(asc(pgSchema.conversationsPostgres.id));
    return rows.map((row) => row.id);
  }
}

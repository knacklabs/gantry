import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ChatInfo } from '../../../../domain/repositories/domain-types.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import {
  normalizeProviderId,
  providerIdForJid as resolveProviderIdForJid,
} from '../../../../channels/provider-registry.js';
import { agentIdForFolder as canonicalAgentIdForFolder } from '../../../../domain/agent/agent-folder-id.js';
import * as pgSchema from '../schema/schema.js';
import {
  lockPersonAliasKey,
  stableId,
} from './person-identity-mappers.postgres.js';

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

export function conversationIdForJid(
  jid: string,
  providerAccountId?: string | null,
): string {
  return providerAccountId
    ? `conversation:${providerAccountId}:${jid}`
    : `conversation:${jid}`;
}

export function agentIdForFolder(folder: string): string {
  return canonicalAgentIdForFolder(folder);
}

export function configVersionIdForAgent(agentId: string): string {
  return `config:${agentId}:1`;
}

export function threadIdFor(
  chatJid: string,
  threadId?: string | null,
  providerAccountId?: string | null,
): string | null {
  const normalized = threadId?.trim();
  if (!normalized) return null;
  return providerAccountId
    ? `thread:${providerAccountId}:${chatJid}:${normalized}`
    : `thread:${chatJid}:${normalized}`;
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
      { cause: err },
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
        name: 'Default Local App',
      })
      .onConflictDoNothing();
    await executor
      .insert(pgSchema.llmProfilesPostgres)
      .values({
        id: DEFAULT_LLM_PROFILE_ID,
        appId: CANONICAL_APP_ID,
        purpose: 'default',
        responseFamily: 'anthropic',
        modelAlias: 'opus',
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
      agentFolder?: string | null;
      isGroup?: boolean | null;
      timestamp?: string | null;
      providerAccountId?: string | null;
    } = {},
    executor: CanonicalExecutor = this.db,
  ): Promise<string> {
    await this.ensureApp(executor);
    const providerId =
      normalizeProviderId(input.channel || providerIdForJid(jid)) || 'app';
    const providerAccountId =
      input.providerAccountId ??
      `channel-providerAccount:${CANONICAL_APP_ID}:${providerId}`;
    const conversationId = conversationIdForJid(jid, input.providerAccountId);
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
      providerAccountId,
      ...(hasKnownKind ? { isGroup: Boolean(input.isGroup) } : {}),
    });
    await executor
      .insert(pgSchema.providersPostgres)
      .values({ id: providerId, displayName: providerId })
      .onConflictDoNothing();
    const providerAccountAgentId = await this.ensureAgent(
      input.agentFolder || providerId,
      input.agentFolder || providerId,
      executor,
    );
    await executor
      .insert(pgSchema.providerAccountsPostgres)
      .values({
        id: providerAccountId,
        appId: CANONICAL_APP_ID,
        agentId: providerAccountAgentId,
        providerId,
        externalIdentityRefJson: json({ providerId }),
        label: providerId,
      })
      .onConflictDoNothing();
    await executor
      .insert(pgSchema.conversationsPostgres)
      .values({
        id: conversationId,
        appId: CANONICAL_APP_ID,
        providerAccountId: providerAccountId,
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
    input: { channel?: string | null; providerAccountId?: string | null } = {},
  ): Promise<string | null> {
    const canonicalThreadId = threadIdFor(
      chatJid,
      threadId,
      input.providerAccountId,
    );
    if (!canonicalThreadId) return null;
    const conversationId = await this.ensureConversation(
      chatJid,
      { channel: input.channel, providerAccountId: input.providerAccountId },
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
      providerAccountId: string;
      externalUserId: string;
      displayName?: string | null;
      timestamp?: string | null;
    },
    executor?: CanonicalExecutor,
  ): Promise<string | null> {
    if (!executor) {
      return this.db.transaction((tx) => this.ensureParticipant(input, tx));
    }
    const externalUserId = input.externalUserId.trim();
    if (!externalUserId) return null;
    const providerAccountId = input.providerAccountId.trim();
    const safeUser = externalUserId.replace(/[^a-zA-Z0-9._:-]/g, '_');
    const participantId = `participant:${input.conversationId}:${safeUser}`;
    const now = input.timestamp || currentIso();
    const aliasKey = {
      appId: CANONICAL_APP_ID,
      provider: input.providerId,
      providerAccountId,
      externalUserId,
    };
    await lockPersonAliasKey(executor, aliasKey);
    const findActiveAlias = async () => {
      const [row] = await executor
        .select({ userId: pgSchema.userAliasesPostgres.userId })
        .from(pgSchema.userAliasesPostgres)
        .where(
          and(
            eq(pgSchema.userAliasesPostgres.appId, CANONICAL_APP_ID),
            eq(pgSchema.userAliasesPostgres.provider, input.providerId),
            sql`COALESCE(${pgSchema.userAliasesPostgres.providerAccountId}, '') = ${providerAccountId}`,
            eq(pgSchema.userAliasesPostgres.externalUserId, externalUserId),
            isNull(pgSchema.userAliasesPostgres.retiredAt),
          ),
        )
        .limit(1);
      return row;
    };
    const existingAlias = await findActiveAlias();
    let participantUserId = existingAlias?.userId;
    if (!participantUserId) {
      const retiredAliases = await executor
        .select({ id: pgSchema.userAliasesPostgres.id })
        .from(pgSchema.userAliasesPostgres)
        .where(
          and(
            eq(pgSchema.userAliasesPostgres.appId, CANONICAL_APP_ID),
            eq(pgSchema.userAliasesPostgres.provider, input.providerId),
            sql`COALESCE(${pgSchema.userAliasesPostgres.providerAccountId}, '') = ${providerAccountId}`,
            eq(pgSchema.userAliasesPostgres.externalUserId, externalUserId),
            isNotNull(pgSchema.userAliasesPostgres.retiredAt),
          ),
        )
        .orderBy(asc(pgSchema.userAliasesPostgres.id));
      const identityParts = [
        CANONICAL_APP_ID,
        input.providerId,
        providerAccountId,
        externalUserId,
        ...retiredAliases.map((row) => row.id),
      ];
      const userId = stableId('person', identityParts);
      const aliasId = stableId('person-alias', identityParts);
      const displayName = input.displayName ?? externalUserId;
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
          set: { displayName, updatedAt: now },
        });
      const [insertedAlias] = await executor
        .insert(pgSchema.userAliasesPostgres)
        .values({
          id: aliasId,
          appId: CANONICAL_APP_ID,
          userId,
          provider: input.providerId,
          providerAccountId,
          externalUserId,
          displayName,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ userId: pgSchema.userAliasesPostgres.userId });
      participantUserId =
        insertedAlias?.userId ?? (await findActiveAlias())?.userId;
      if (!participantUserId) {
        throw new Error('Could not create or resolve an active person alias.');
      }
    }
    await executor
      .insert(pgSchema.conversationParticipantsPostgres)
      .values({
        id: participantId,
        appId: CANONICAL_APP_ID,
        conversationId: input.conversationId,
        userId: participantUserId,
        externalUserId,
        role: 'member',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgSchema.conversationParticipantsPostgres.id,
        set: {
          userId: participantUserId,
          externalUserId,
          status: 'active',
          updatedAt: now,
        },
      });
    return participantUserId;
  }

  async listChats(): Promise<ChatInfo[]> {
    const c = pgSchema.conversationsPostgres;
    const ci = pgSchema.providerAccountsPostgres;
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
      .innerJoin(ci, eq(ci.id, c.providerAccountId))
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
        providerAccountId: pgSchema.conversationsPostgres.providerAccountId,
      })
      .from(pgSchema.conversationsPostgres)
      .where(eq(pgSchema.conversationsPostgres.id, conversationId))
      .limit(1);
    return rows[0]?.providerAccountId;
  }

  async listConversationIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: pgSchema.conversationsPostgres.id })
      .from(pgSchema.conversationsPostgres)
      .orderBy(asc(pgSchema.conversationsPostgres.id));
    return rows.map((row) => row.id);
  }
}

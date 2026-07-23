import { and, asc, eq, isNull, like } from 'drizzle-orm';

import type { AgentId } from '../../../../domain/agent/agent.js';
import { folderForAgentId } from '../../../../domain/agent/agent-folder-id.js';
import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import { logger } from '../../../../infrastructure/logging/logger.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { parseAgentThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  agentIdForFolder,
  conversationIdForJid,
  json,
  parseJson,
  PostgresCanonicalGraphRepository,
} from './canonical-graph-repository.postgres.js';

export interface CanonicalBindingRecord {
  id: string;
  agentId: string;
  providerAccountId: string;
  conversationId: string;
  threadId: string | null;
  status: string;
  conversationExternalRefJson: string | null;
  conversationKind: string;
  memorySubjectJson: string;
  displayName: string;
  createdAt: string;
  updatedAt?: string;
}

const CONVERSATION_ROUTE_BINDING_ID_PREFIX = 'conversation-route:';

export function conversationRouteKeyFromBindingRow(
  row: Pick<CanonicalBindingRecord, 'id'>,
): string | undefined {
  if (!row.id.startsWith(CONVERSATION_ROUTE_BINDING_ID_PREFIX)) {
    return undefined;
  }
  return row.id.slice(CONVERSATION_ROUTE_BINDING_ID_PREFIX.length) || undefined;
}

function routeBindingId(jid: string): string {
  return `${CONVERSATION_ROUTE_BINDING_ID_PREFIX}${jid}`;
}

export function normalizeRouteAgentId(agentId: string): string {
  return agentIdForFolder(folderForAgentId(agentId as AgentId) ?? agentId);
}

function routeMemorySubject(
  conversationId: string,
  group: ConversationRoute,
): Record<string, unknown> {
  return {
    kind: 'conversation',
    appId: CANONICAL_APP_ID,
    conversationId,
    route: {
      conversationId,
      trigger: group.trigger,
      requiresTrigger: group.requiresTrigger ?? true,
      ...(group.agentConfig ? { agentConfig: group.agentConfig } : {}),
    },
  };
}

export class PostgresCanonicalBindingRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async saveConversationRoute(
    jid: string,
    group: ConversationRoute,
  ): Promise<void> {
    const parsedRouteKey = parseAgentThreadQueueKey(jid);
    const { chatJid } = parsedRouteKey;
    const requestedProviderAccountId =
      group.providerAccountId?.trim() || undefined;
    const resolvedAgentId = normalizeRouteAgentId(group.folder);
    if (
      parsedRouteKey.agentId !== undefined &&
      normalizeRouteAgentId(parsedRouteKey.agentId) !== resolvedAgentId
    ) {
      throw new Error(
        `Conversation route ${jid} agent qualifier ${parsedRouteKey.agentId} does not match resolved agent ${resolvedAgentId}`,
      );
    }
    if (
      requestedProviderAccountId !== undefined &&
      parsedRouteKey.providerAccountId !== undefined &&
      parsedRouteKey.providerAccountId !== requestedProviderAccountId
    ) {
      throw new Error(
        `Conversation route ${jid} provider account qualifier ${parsedRouteKey.providerAccountId} does not match requested provider account ${requestedProviderAccountId}`,
      );
    }
    const preEnsureProviderAccountId =
      requestedProviderAccountId ?? parsedRouteKey.providerAccountId;
    await this.db.transaction(async (tx) => {
      const resolvedProviderAccountId =
        preEnsureProviderAccountId ??
        (group.conversationId
          ? (
              await this.graph.getConversationInstallationId(
                group.conversationId,
                tx,
              )
            )?.trim()
          : undefined);
      const conversationId = await this.graph.ensureConversation(
        chatJid,
        {
          name: group.name,
          agentFolder: group.folder,
          existingConversationId: group.conversationId,
          providerAccountId: resolvedProviderAccountId,
          isGroup:
            group.conversationKind === 'dm'
              ? false
              : group.conversationKind === 'channel'
                ? true
                : group.requiresTrigger !== false,
        },
        tx,
      );
      const agentId = await this.graph.ensureAgent(
        group.folder,
        group.name,
        tx,
      );
      const installationProviderAccountId = (
        await this.graph.getConversationInstallationId(conversationId, tx)
      )?.trim();
      const providerAccountId =
        resolvedProviderAccountId ?? installationProviderAccountId;
      if (!providerAccountId) {
        throw new Error(
          `Cannot persist conversation route ${jid} without providerAccountId`,
        );
      }
      if (
        installationProviderAccountId &&
        installationProviderAccountId !== providerAccountId
      ) {
        throw new Error(
          `Conversation route ${jid} resolved provider account ${installationProviderAccountId}, expected ${providerAccountId}`,
        );
      }
      // New conversations are canonicalized by ensureConversation. Existing
      // legacy IDs remain authoritative until the transactional Phase 8 restamp
      // can migrate their conversation, graph, and memory references together.
      const now = group.added_at || currentIso();
      await tx
        .insert(pgSchema.conversationInstallsPostgres)
        .values({
          id: routeBindingId(jid),
          appId: CANONICAL_APP_ID,
          agentId,
          providerAccountId,
          conversationId,
          displayName: group.name,
          status: 'active',
          senderPolicy: 'provider_native',
          controlPolicy: 'conversation_approvers',
          memoryScope: 'conversation',
          memorySubjectJson: json(routeMemorySubject(conversationId, group)),
          permissionPolicyIdsJson: '[]',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pgSchema.conversationInstallsPostgres.id,
          set: {
            agentId,
            providerAccountId,
            conversationId,
            displayName: group.name,
            status: 'active',
            senderPolicy: 'provider_native',
            controlPolicy: 'conversation_approvers',
            memoryScope: 'conversation',
            memorySubjectJson: json(routeMemorySubject(conversationId, group)),
            updatedAt: now,
          },
        });
    });
  }

  async deleteConversationRoute(jid: string): Promise<void> {
    await this.db
      .delete(pgSchema.conversationInstallsPostgres)
      .where(eq(pgSchema.conversationInstallsPostgres.id, routeBindingId(jid)));
  }

  async listConversationRoutes(): Promise<CanonicalBindingRecord[]> {
    const b = pgSchema.conversationInstallsPostgres;
    const c = pgSchema.conversationsPostgres;
    const pa = pgSchema.providerAccountsPostgres;
    return this.db
      .select({
        id: b.id,
        agentId: b.agentId,
        providerAccountId: b.providerAccountId,
        conversationId: b.conversationId,
        threadId: b.threadId,
        status: b.status,
        conversationExternalRefJson: c.externalRefJson,
        conversationKind: c.kind,
        memorySubjectJson: b.memorySubjectJson,
        displayName: b.displayName,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      })
      .from(b)
      .innerJoin(c, eq(c.id, b.conversationId))
      .innerJoin(pa, eq(pa.id, b.providerAccountId))
      .where(
        and(
          eq(b.appId, CANONICAL_APP_ID),
          like(b.id, `${CONVERSATION_ROUTE_BINDING_ID_PREFIX}%`),
          eq(b.status, 'active'),
          eq(pa.status, 'active'),
          isNull(b.threadId),
        ),
      )
      .orderBy(asc(b.createdAt));
  }
}

export function bindingRowToGroup(
  row: CanonicalBindingRecord,
): { jid: string; group: ConversationRoute } | undefined {
  if (!row.id.startsWith(CONVERSATION_ROUTE_BINDING_ID_PREFIX))
    return undefined;
  if (row.status !== 'active' || row.threadId) return undefined;
  const routeSubject = parseJson<{
    route?: {
      agentConfig?: ConversationRoute['agentConfig'];
      trigger?: string;
      requiresTrigger?: boolean;
    };
  }>(row.memorySubjectJson, {});
  const jid = conversationRouteKeyFromBindingRow(row);
  if (!jid) return undefined;
  const providerAccountId = row.providerAccountId;
  if (!providerAccountId) return undefined;
  const parsedRouteKey = parseAgentThreadQueueKey(jid);
  const normalizedRowAgentId = normalizeRouteAgentId(row.agentId);
  if (
    (parsedRouteKey.agentId !== undefined &&
      normalizeRouteAgentId(parsedRouteKey.agentId) !== normalizedRowAgentId) ||
    (parsedRouteKey.providerAccountId !== undefined &&
      parsedRouteKey.providerAccountId !== providerAccountId)
  ) {
    logger.warn(
      {
        event: 'conversation_route_row_conflicting_qualifiers',
        rowId: row.id,
        parsedAgentId: parsedRouteKey.agentId,
        rowAgentId: row.agentId,
        parsedProviderAccountId: parsedRouteKey.providerAccountId,
        rowProviderAccountId: providerAccountId,
      },
      'Skipped conflicting conversation route row during load',
    );
    return undefined;
  }
  const expectedCanonicalConversationId = conversationIdForJid(
    parsedRouteKey.chatJid,
    providerAccountId,
  );
  if (row.conversationId !== expectedCanonicalConversationId) {
    logger.warn(
      {
        event: 'conversation_route_conversation_id_noncanonical',
        rowId: row.id,
        storedConversationId: row.conversationId,
        expectedCanonicalConversationId,
      },
      'Loaded non-canonical conversation route conversation id',
    );
  }
  const folder =
    folderForAgentId(normalizedRowAgentId as AgentId) ?? row.agentId;
  const agentConfig = routeSubject.route?.agentConfig;
  const conversationKind =
    row.conversationKind === 'direct' || row.conversationKind === 'dm'
      ? 'dm'
      : 'channel';
  return {
    jid,
    group: {
      name: row.displayName,
      folder,
      conversationId: row.conversationId,
      trigger: routeSubject.route?.trigger?.trim() || `@${folder || 'agent'}`,
      added_at: row.createdAt,
      requiresTrigger: routeSubject.route?.requiresTrigger ?? true,
      conversationKind,
      providerAccountId,
      ...(agentConfig ? { agentConfig } : {}),
    },
  };
}

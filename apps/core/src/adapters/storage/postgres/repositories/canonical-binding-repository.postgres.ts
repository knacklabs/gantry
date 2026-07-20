import { and, asc, eq, isNull, like } from 'drizzle-orm';

import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { parseAgentThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
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
}

const CONVERSATION_ROUTE_BINDING_ID_PREFIX = 'conversation-route:';

function routeBindingId(jid: string): string {
  return `${CONVERSATION_ROUTE_BINDING_ID_PREFIX}${jid}`;
}

function routeMemorySubject(
  conversationId: string,
  group: ConversationRoute,
): Record<string, unknown> {
  const route: Record<string, unknown> = {
    trigger: group.trigger,
    requiresTrigger: group.requiresTrigger ?? true,
    ...(group.agentConfig ? { agentConfig: group.agentConfig } : {}),
    ...(group.senderIdentityEvidenceType
      ? { senderIdentityEvidenceType: group.senderIdentityEvidenceType }
      : {}),
    ...(group.systemSenderIds?.length
      ? { systemSenderIds: group.systemSenderIds }
      : {}),
  };
  return {
    kind: 'conversation',
    appId: CANONICAL_APP_ID,
    conversationId,
    route: {
      conversationId: group.conversationId,
      trigger: group.trigger,
      requiresTrigger: group.requiresTrigger ?? true,
      ...(group.agentConfig ? { agentConfig: group.agentConfig } : {}),
      ...(group.senderIdentityEvidenceType
        ? { senderIdentityEvidenceType: group.senderIdentityEvidenceType }
        : {}),
      ...(group.systemSenderIds?.length
        ? { systemSenderIds: group.systemSenderIds }
        : {}),
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
    const { chatJid } = parseAgentThreadQueueKey(jid);
    await this.db.transaction(async (tx) => {
      const conversationId = await this.graph.ensureConversation(
        chatJid,
        {
          name: group.name,
          agentFolder: group.folder,
          providerAccountId: group.providerAccountId,
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
      const providerAccountId = await this.graph.getConversationInstallationId(
        conversationId,
        tx,
      );
      if (!providerAccountId) return;
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
  if (!row.id.startsWith(CONVERSATION_ROUTE_BINDING_ID_PREFIX)) {
    return undefined;
  }
  if (row.status !== 'active' || row.threadId) return undefined;
  const externalRef = parseJson<{ jid?: string; value?: string }>(
    row.conversationExternalRefJson,
    {},
  );
  const routeSubject = parseJson<{
    route?: {
      agentConfig?: ConversationRoute['agentConfig'];
      conversationId?: string;
      trigger?: string;
      requiresTrigger?: boolean;
      senderIdentityEvidenceType?: ConversationRoute['senderIdentityEvidenceType'];
      systemSenderIds?: ConversationRoute['systemSenderIds'];
    };
  }>(row.memorySubjectJson, {});
  const bindingIdRouteKey = row.id.slice(
    CONVERSATION_ROUTE_BINDING_ID_PREFIX.length,
  );
  const jid = bindingIdRouteKey || externalRef.jid || externalRef.value;
  if (!jid) return undefined;
  const folder = row.agentId.startsWith('agent:')
    ? row.agentId.slice('agent:'.length)
    : row.agentId;
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
      conversationId: routeSubject.route?.conversationId ?? row.conversationId,
      trigger: routeSubject.route?.trigger?.trim() || `@${folder || 'agent'}`,
      added_at: row.createdAt,
      requiresTrigger: routeSubject.route?.requiresTrigger ?? true,
      conversationKind,
      providerAccountId: row.providerAccountId,
      ...(routeSubject.route?.senderIdentityEvidenceType
        ? {
            senderIdentityEvidenceType:
              routeSubject.route.senderIdentityEvidenceType,
          }
        : {}),
      ...(routeSubject.route?.systemSenderIds?.length
        ? { systemSenderIds: routeSubject.route.systemSenderIds }
        : {}),
      ...(agentConfig ? { agentConfig } : {}),
    },
  };
}

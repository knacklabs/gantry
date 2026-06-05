import { and, asc, eq, isNull, like } from 'drizzle-orm';

import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
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
  conversationId: string;
  threadId: string | null;
  status: string;
  conversationExternalRefJson: string | null;
  conversationKind: string;
  memorySubjectJson: string;
  displayName: string;
  triggerPattern: string | null;
  requiresTrigger: boolean;
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
  return {
    kind: 'conversation',
    appId: CANONICAL_APP_ID,
    conversationId,
    ...(group.agentConfig ? { route: { agentConfig: group.agentConfig } } : {}),
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
    await this.db.transaction(async (tx) => {
      const conversationId = await this.graph.ensureConversation(
        jid,
        {
          name: group.name,
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
      const providerConnectionId =
        await this.graph.getConversationInstallationId(conversationId, tx);
      if (!providerConnectionId) return;
      const now = group.added_at || currentIso();
      await tx
        .insert(pgSchema.agentConversationBindingsPostgres)
        .values({
          id: routeBindingId(jid),
          appId: CANONICAL_APP_ID,
          agentId,
          providerConnectionId,
          conversationId,
          displayName: group.name,
          status: 'active',
          triggerMode: group.requiresTrigger === false ? 'always' : 'keyword',
          triggerPattern: group.trigger,
          requiresTrigger: group.requiresTrigger ?? true,
          memoryScope: 'conversation',
          memorySubjectJson: json(routeMemorySubject(conversationId, group)),
          permissionPolicyIdsJson: '[]',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pgSchema.agentConversationBindingsPostgres.id,
          set: {
            agentId,
            providerConnectionId,
            conversationId,
            displayName: group.name,
            status: 'active',
            triggerMode: group.requiresTrigger === false ? 'always' : 'keyword',
            triggerPattern: group.trigger,
            requiresTrigger: group.requiresTrigger ?? true,
            memoryScope: 'conversation',
            memorySubjectJson: json(routeMemorySubject(conversationId, group)),
            updatedAt: now,
          },
        });
    });
  }

  async deleteConversationRoute(jid: string): Promise<void> {
    await this.db
      .delete(pgSchema.agentConversationBindingsPostgres)
      .where(
        eq(pgSchema.agentConversationBindingsPostgres.id, routeBindingId(jid)),
      );
  }

  async listConversationRoutes(): Promise<CanonicalBindingRecord[]> {
    const b = pgSchema.agentConversationBindingsPostgres;
    const c = pgSchema.conversationsPostgres;
    return this.db
      .select({
        id: b.id,
        agentId: b.agentId,
        conversationId: b.conversationId,
        threadId: b.threadId,
        status: b.status,
        conversationExternalRefJson: c.externalRefJson,
        conversationKind: c.kind,
        memorySubjectJson: b.memorySubjectJson,
        displayName: b.displayName,
        triggerPattern: b.triggerPattern,
        requiresTrigger: b.requiresTrigger,
        createdAt: b.createdAt,
      })
      .from(b)
      .innerJoin(c, eq(c.id, b.conversationId))
      .where(
        and(
          eq(b.appId, CANONICAL_APP_ID),
          like(b.id, `${CONVERSATION_ROUTE_BINDING_ID_PREFIX}%`),
          eq(b.status, 'active'),
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
    route?: { agentConfig?: ConversationRoute['agentConfig'] };
  }>(row.memorySubjectJson, {});
  const jid =
    externalRef.jid ||
    (row.conversationId.startsWith('conversation:')
      ? row.conversationId.slice('conversation:'.length)
      : externalRef.value);
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
      trigger: row.triggerPattern?.trim() || `@${folder || 'agent'}`,
      added_at: row.createdAt,
      requiresTrigger: row.requiresTrigger,
      conversationKind,
      ...(agentConfig ? { agentConfig } : {}),
    },
  };
}

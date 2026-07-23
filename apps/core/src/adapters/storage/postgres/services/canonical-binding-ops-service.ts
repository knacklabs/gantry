import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import { logger } from '../../../../infrastructure/logging/logger.js';
import { parseAgentThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import {
  bindingRowToGroup,
  conversationRouteKeyFromBindingRow,
  normalizeRouteAgentId,
  type CanonicalBindingRecord,
  type PostgresCanonicalBindingRepository,
} from '../repositories/canonical-binding-repository.postgres.js';

interface RouteAliasCandidate {
  row: CanonicalBindingRecord;
  routeKey: string;
  tier: number;
}

function normalizeBindingRow(
  row: CanonicalBindingRecord,
): CanonicalBindingRecord {
  return {
    ...row,
    agentId: row.agentId.trim(),
    providerAccountId: row.providerAccountId.trim(),
  };
}

function routeAliasTier(
  row: CanonicalBindingRecord,
  routeKey: string,
): number | undefined {
  const parsed = parseAgentThreadQueueKey(routeKey);
  if (parsed.threadId) return undefined;
  if (!parsed.agentId && !parsed.providerAccountId) return 1;
  if (!parsed.agentId) return undefined;
  if (
    normalizeRouteAgentId(parsed.agentId) !== normalizeRouteAgentId(row.agentId)
  )
    return undefined;
  if (!parsed.providerAccountId) return 2;
  return parsed.providerAccountId === row.providerAccountId ? 3 : undefined;
}

function compareRouteAliasPreference(
  left: RouteAliasCandidate,
  right: RouteAliasCandidate,
): number {
  if (left.tier !== right.tier) return right.tier - left.tier;

  const leftUpdatedAt = Date.parse(left.row.updatedAt ?? left.row.createdAt);
  const rightUpdatedAt = Date.parse(right.row.updatedAt ?? right.row.createdAt);
  const leftTimestamp = Number.isNaN(leftUpdatedAt)
    ? Number.NEGATIVE_INFINITY
    : leftUpdatedAt;
  const rightTimestamp = Number.isNaN(rightUpdatedAt)
    ? Number.NEGATIVE_INFINITY
    : rightUpdatedAt;
  if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
  if (left.routeKey === right.routeKey) return 0;
  return left.routeKey < right.routeKey ? -1 : 1;
}

export class CanonicalBindingOpsService {
  constructor(
    private readonly repository: PostgresCanonicalBindingRepository,
  ) {}

  async getConversationRoute(
    jid: string,
  ): Promise<ConversationRoute | undefined> {
    return (await this.getAllConversationRoutes())[jid];
  }

  async setConversationRoute(
    jid: string,
    group: ConversationRoute,
  ): Promise<void> {
    await this.repository.saveConversationRoute(jid, group);
  }

  async deleteConversationRoute(jid: string): Promise<void> {
    await this.repository.deleteConversationRoute(jid);
  }

  async getAllConversationRoutes(): Promise<Record<string, ConversationRoute>> {
    const rows = (await this.repository.listConversationRoutes()).map(
      normalizeBindingRow,
    );
    const aliasesByIdentity = new Map<string, RouteAliasCandidate[]>();
    for (const row of rows) {
      if (row.status !== 'active' || row.threadId) continue;
      const routeKey = conversationRouteKeyFromBindingRow(row);
      if (!routeKey) continue;
      const parsed = parseAgentThreadQueueKey(routeKey);
      const tier = routeAliasTier(row, routeKey);
      if (tier === undefined) continue;
      const identity = `${parsed.chatJid}\0${normalizeRouteAgentId(row.agentId)}\0${row.providerAccountId}`;
      const identityAliases = aliasesByIdentity.get(identity) ?? [];
      identityAliases.push({ row, routeKey, tier });
      aliasesByIdentity.set(identity, identityAliases);
    }

    const droppedRows = new Set<CanonicalBindingRecord>();
    for (const identityAliases of aliasesByIdentity.values()) {
      if (identityAliases.length < 2) continue;
      // Total order: fully-qualified > agent-qualified > bare. Within one
      // tier, newest updatedAt wins (createdAt fallback), then the
      // lexicographically smallest route key. Exactly one alias survives.
      const [winner, ...droppedAliases] = [...identityAliases].sort(
        compareRouteAliasPreference,
      );
      if (!winner) continue;

      for (const droppedAlias of droppedAliases) {
        const { row, routeKey } = droppedAlias;
        droppedRows.add(row);
        const parsed = parseAgentThreadQueueKey(routeKey);
        logger.warn(
          {
            event: 'conversation_route_alias_dropped',
            droppedRouteId: row.id,
            droppedConversationId: row.conversationId,
            keptRouteIds: [winner.row.id],
            keptConversationIds: [winner.row.conversationId],
            chatJid: parsed.chatJid,
            agentId: row.agentId,
            providerAccountId: row.providerAccountId,
          },
          'Dropped stale conversation route alias during load',
        );
      }
    }

    const result: Record<string, ConversationRoute> = {};
    for (const row of rows) {
      if (droppedRows.has(row)) continue;
      if (row.status === 'active' && !row.threadId) {
        const reason = !conversationRouteKeyFromBindingRow(row)
          ? 'missing_route_key'
          : !row.providerAccountId
            ? 'missing_provider_account_id'
            : undefined;
        if (reason) {
          logger.warn(
            {
              event: 'conversation_route_row_skipped',
              rowId: row.id,
              reason,
            },
            'Skipped malformed conversation route row during load',
          );
          continue;
        }
      }
      const binding = bindingRowToGroup(row);
      if (binding) result[binding.jid] = binding.group;
    }
    return result;
  }
}

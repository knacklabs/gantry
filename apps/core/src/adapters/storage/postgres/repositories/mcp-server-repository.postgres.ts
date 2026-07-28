import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import type {
  AgentMcpAccessSnapshot,
  McpServerRepository,
} from '../../../../domain/ports/repositories.js';
import type {
  AgentMcpServerBinding,
  MaterializedMcpServer,
  McpServerAuditEvent,
  McpServerDefinition,
  McpServerId,
} from '../../../../domain/mcp/mcp-servers.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import * as pgSchema from '../schema/schema.js';

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function parseJsonRecord(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function jsonArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (typeof value !== 'string') return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : [];
}

function fromDbJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return {
    id: row.id,
    appId: row.app_id,
    agentId: row.agent_id,
    serverId: row.server_id,
    status: row.status,
    required: row.required,
    permissionPolicyIdsJson: row.permission_policy_ids_json,
    allowedToolPatternsJson: row.allowed_tool_patterns_json,
    conversationId: row.conversation_id,
    threadId: row.thread_id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    createdSource: row.created_source,
    riskClass: row.risk_class,
    requestedBy: row.requested_by,
    requestedReason: row.requested_reason,
    transport: row.transport,
    configJson: row.config_json,
    autoApproveToolPatternsJson: row.auto_approve_tool_patterns_json,
    credentialRefsJson: row.credential_refs_json,
    networkHostsJson: row.network_hosts_json,
    sandboxProfileId: row.sandbox_profile_id,
    disabledBy: row.disabled_by,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresMcpServerRepository implements McpServerRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getServer(id: McpServerId): Promise<McpServerDefinition | null> {
    const [row] = await this.db
      .select()
      .from(pgSchema.mcpServersPostgres)
      .where(eq(pgSchema.mcpServersPostgres.id, id))
      .limit(1);
    return row ? this.mapServer(row) : null;
  }

  async getServerByName(input: {
    appId: McpServerDefinition['appId'];
    name: string;
  }): Promise<McpServerDefinition | null> {
    const [row] = await this.db
      .select()
      .from(pgSchema.mcpServersPostgres)
      .where(
        and(
          eq(pgSchema.mcpServersPostgres.appId, input.appId),
          eq(pgSchema.mcpServersPostgres.name, input.name),
        ),
      )
      .limit(1);
    return row ? this.mapServer(row) : null;
  }

  async listServers(input: {
    appId: McpServerDefinition['appId'];
    statuses?: McpServerDefinition['status'][];
    limit?: number;
    cursor?: string;
  }): Promise<McpServerDefinition[]> {
    const filters = [eq(pgSchema.mcpServersPostgres.appId, input.appId)];
    if (input.statuses?.length) {
      filters.push(inArray(pgSchema.mcpServersPostgres.status, input.statuses));
    }
    if (input.cursor) {
      filters.push(lt(pgSchema.mcpServersPostgres.updatedAt, input.cursor));
    }
    const rows = await this.db
      .select()
      .from(pgSchema.mcpServersPostgres)
      .where(and(...filters))
      .orderBy(desc(pgSchema.mcpServersPostgres.updatedAt))
      .limit(normalizeLimit(input.limit));
    return rows.map((row) => this.mapServer(row));
  }

  async saveServer(definition: McpServerDefinition): Promise<void> {
    await this.db
      .insert(pgSchema.mcpServersPostgres)
      .values({
        id: definition.id,
        appId: definition.appId,
        name: definition.name,
        displayName: definition.displayName ?? null,
        description: definition.description ?? null,
        status: definition.status,
        createdSource: definition.createdSource,
        riskClass: definition.riskClass,
        requestedBy: definition.requestedBy ?? null,
        requestedReason: definition.requestedReason ?? null,
        transport: definition.transport,
        configJson: encodeJson(definition.config),
        allowedToolPatternsJson: encodeJson(definition.allowedToolPatterns),
        autoApproveToolPatternsJson: encodeJson(
          definition.autoApproveToolPatterns,
        ),
        credentialRefsJson: encodeJson(definition.credentialRefs),
        networkHostsJson: encodeJson(definition.networkHosts),
        sandboxProfileId: definition.sandboxProfileId ?? null,
        disabledBy: definition.disabledBy ?? null,
        disabledAt: definition.disabledAt ?? null,
        createdAt: definition.createdAt,
        updatedAt: definition.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.mcpServersPostgres.id,
        set: {
          displayName: definition.displayName ?? null,
          description: definition.description ?? null,
          status: definition.status,
          riskClass: definition.riskClass,
          requestedBy: definition.requestedBy ?? null,
          requestedReason: definition.requestedReason ?? null,
          transport: definition.transport,
          configJson: encodeJson(definition.config),
          allowedToolPatternsJson: encodeJson(definition.allowedToolPatterns),
          autoApproveToolPatternsJson: encodeJson(
            definition.autoApproveToolPatterns,
          ),
          credentialRefsJson: encodeJson(definition.credentialRefs),
          networkHostsJson: encodeJson(definition.networkHosts),
          sandboxProfileId: definition.sandboxProfileId ?? null,
          disabledBy: definition.disabledBy ?? null,
          disabledAt: definition.disabledAt ?? null,
          updatedAt: definition.updatedAt,
        },
      });
  }

  async transitionServerStatus(input: {
    appId: McpServerDefinition['appId'];
    serverId: McpServerId;
    expectedStatus: McpServerDefinition['status'];
    next: McpServerDefinition;
  }): Promise<McpServerDefinition | null> {
    const [row] = await this.db
      .update(pgSchema.mcpServersPostgres)
      .set({
        displayName: input.next.displayName ?? null,
        description: input.next.description ?? null,
        status: input.next.status,
        riskClass: input.next.riskClass,
        requestedBy: input.next.requestedBy ?? null,
        requestedReason: input.next.requestedReason ?? null,
        transport: input.next.transport,
        configJson: encodeJson(input.next.config),
        allowedToolPatternsJson: encodeJson(input.next.allowedToolPatterns),
        autoApproveToolPatternsJson: encodeJson(
          input.next.autoApproveToolPatterns,
        ),
        credentialRefsJson: encodeJson(input.next.credentialRefs),
        sandboxProfileId: input.next.sandboxProfileId ?? null,
        disabledBy: input.next.disabledBy ?? null,
        disabledAt: input.next.disabledAt ?? null,
        updatedAt: input.next.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.mcpServersPostgres.id, input.serverId),
          eq(pgSchema.mcpServersPostgres.appId, input.appId),
          eq(pgSchema.mcpServersPostgres.status, input.expectedStatus),
        ),
      )
      .returning();
    return row ? this.mapServer(row) : null;
  }

  async saveAgentBinding(binding: AgentMcpServerBinding): Promise<void> {
    await this.db
      .insert(pgSchema.agentMcpServerBindingsPostgres)
      .values({
        id: binding.id,
        appId: binding.appId,
        agentId: binding.agentId,
        serverId: binding.serverId,
        status: binding.status,
        required: binding.required,
        permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
        allowedToolPatternsJson: encodeJson(binding.allowedToolPatterns),
        conversationId: binding.conversationId ?? null,
        threadId: binding.threadId ?? null,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentMcpServerBindingsPostgres.id,
        set: {
          status: binding.status,
          required: binding.required,
          permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
          allowedToolPatternsJson: encodeJson(binding.allowedToolPatterns),
          conversationId: binding.conversationId ?? null,
          threadId: binding.threadId ?? null,
          updatedAt: binding.updatedAt,
        },
      });
  }

  async disableAgentBinding(input: {
    appId: AgentMcpServerBinding['appId'];
    agentId: AgentMcpServerBinding['agentId'];
    serverId: AgentMcpServerBinding['serverId'];
    updatedAt: string;
  }): Promise<AgentMcpServerBinding | null> {
    const [row] = await this.db
      .update(pgSchema.agentMcpServerBindingsPostgres)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(pgSchema.agentMcpServerBindingsPostgres.appId, input.appId),
          eq(pgSchema.agentMcpServerBindingsPostgres.agentId, input.agentId),
          eq(pgSchema.agentMcpServerBindingsPostgres.serverId, input.serverId),
        ),
      )
      .returning();
    return row ? this.mapBinding(row) : null;
  }

  async listAgentBindings(input: {
    appId: AgentMcpServerBinding['appId'];
    agentId: AgentMcpServerBinding['agentId'];
    limit?: number;
    cursor?: string;
  }): Promise<AgentMcpServerBinding[]> {
    return this.listAgentBindingRows(input);
  }

  async listAgentMcpAccessSnapshot(input: {
    appId: AgentMcpServerBinding['appId'];
    agentId: AgentMcpServerBinding['agentId'];
  }): Promise<AgentMcpAccessSnapshot> {
    const result = await this.db.execute<{
      active_bindings: unknown;
      materialized_servers: unknown;
    }>(sql`
      WITH newest_bindings AS (
        SELECT *
        FROM agent_mcp_server_bindings
        WHERE app_id = ${input.appId}
          AND agent_id = ${input.agentId}
        ORDER BY created_at DESC
        LIMIT 500
      )
      SELECT
        (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'binding', to_jsonb(b),
            'definition', CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s) END
          ) ORDER BY b.created_at DESC), '[]'::jsonb)
          FROM newest_bindings b
          LEFT JOIN mcp_servers s
            ON s.id = b.server_id
           AND s.app_id = ${input.appId}
          WHERE b.status = 'active'
        ) AS active_bindings,
        (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'binding', to_jsonb(b),
            'definition', to_jsonb(s)
          ) ORDER BY s.name), '[]'::jsonb)
          FROM newest_bindings b
          INNER JOIN mcp_servers s
            ON s.id = b.server_id
          WHERE b.status = 'active'
            AND s.app_id = ${input.appId}
            AND s.status = 'active'
        ) AS materialized_servers
    `);
    const row = result.rows[0];
    return {
      activeBindings: jsonArray(row?.active_bindings).map((entry) => ({
        binding: this.mapBinding(fromDbJson(entry.binding) as never),
        definition: entry.definition
          ? this.mapServer(fromDbJson(entry.definition) as never)
          : null,
      })),
      materializedServers: jsonArray(row?.materialized_servers).map(
        (entry) => ({
          binding: this.mapBinding(fromDbJson(entry.binding) as never),
          definition: this.mapServer(fromDbJson(entry.definition) as never),
        }),
      ),
    };
  }

  async listAgentBindingsForAgents(input: {
    appId: AgentMcpServerBinding['appId'];
    agentIds: readonly AgentMcpServerBinding['agentId'][];
    limitPerAgent?: number;
  }): Promise<AgentMcpServerBinding[]> {
    return this.listAgentBindingRows({
      appId: input.appId,
      agentIds: input.agentIds,
      limit: (input.limitPerAgent ?? 500) * Math.max(input.agentIds.length, 1),
    });
  }

  private async listAgentBindingRows(input: {
    appId: AgentMcpServerBinding['appId'];
    agentId?: AgentMcpServerBinding['agentId'];
    agentIds?: readonly AgentMcpServerBinding['agentId'][];
    limit?: number;
    cursor?: string;
  }): Promise<AgentMcpServerBinding[]> {
    if (input.agentIds?.length === 0) return [];
    const filters = [
      eq(pgSchema.agentMcpServerBindingsPostgres.appId, input.appId),
    ];
    if (input.agentId) {
      filters.push(
        eq(pgSchema.agentMcpServerBindingsPostgres.agentId, input.agentId),
      );
    }
    if (input.agentIds?.length) {
      filters.push(
        inArray(pgSchema.agentMcpServerBindingsPostgres.agentId, [
          ...input.agentIds,
        ]),
      );
    }
    if (input.cursor) {
      filters.push(
        lt(pgSchema.agentMcpServerBindingsPostgres.createdAt, input.cursor),
      );
    }
    const rows = await this.db
      .select()
      .from(pgSchema.agentMcpServerBindingsPostgres)
      .where(and(...filters))
      .orderBy(
        asc(pgSchema.agentMcpServerBindingsPostgres.agentId),
        desc(pgSchema.agentMcpServerBindingsPostgres.createdAt),
      )
      .limit(normalizeLimit(input.limit));
    return rows.map((row) => this.mapBinding(row));
  }

  async listMaterializedServersForAgent(input: {
    appId: AgentMcpServerBinding['appId'];
    agentId: AgentMcpServerBinding['agentId'];
    serverIds?: readonly McpServerId[];
  }): Promise<MaterializedMcpServer[]> {
    if (input.serverIds && input.serverIds.length === 0) {
      return [];
    }
    const filters = [
      eq(pgSchema.agentMcpServerBindingsPostgres.appId, input.appId),
      eq(pgSchema.agentMcpServerBindingsPostgres.agentId, input.agentId),
      eq(pgSchema.agentMcpServerBindingsPostgres.status, 'active'),
      eq(pgSchema.mcpServersPostgres.appId, input.appId),
      eq(pgSchema.mcpServersPostgres.status, 'active'),
    ];
    if (input.serverIds) {
      filters.push(
        inArray(pgSchema.agentMcpServerBindingsPostgres.serverId, [
          ...input.serverIds,
        ]),
      );
    }
    const rows = await this.db
      .select({
        binding: pgSchema.agentMcpServerBindingsPostgres,
        definition: pgSchema.mcpServersPostgres,
      })
      .from(pgSchema.agentMcpServerBindingsPostgres)
      .innerJoin(
        pgSchema.mcpServersPostgres,
        eq(
          pgSchema.agentMcpServerBindingsPostgres.serverId,
          pgSchema.mcpServersPostgres.id,
        ),
      )
      .where(and(...filters))
      .orderBy(asc(pgSchema.mcpServersPostgres.name));
    return rows.map((row) => ({
      binding: this.mapBinding(row.binding),
      definition: this.mapServer(row.definition),
    }));
  }

  async appendAuditEvent(event: McpServerAuditEvent): Promise<void> {
    await this.db.insert(pgSchema.mcpServerAuditEventsPostgres).values({
      id: event.id,
      appId: event.appId,
      agentId: event.agentId ?? null,
      serverId: event.serverId ?? null,
      bindingId: event.bindingId ?? null,
      eventType: event.eventType,
      actorId: event.actorId ?? null,
      reason: event.reason ?? null,
      metadataJson: encodeJson(event.metadata),
      createdAt: event.createdAt,
    });
  }

  async listAuditEvents(input: {
    appId: McpServerAuditEvent['appId'];
    serverId?: McpServerId;
    limit?: number;
    cursor?: string;
  }): Promise<McpServerAuditEvent[]> {
    const filters = [
      eq(pgSchema.mcpServerAuditEventsPostgres.appId, input.appId),
    ];
    if (input.serverId) {
      filters.push(
        eq(pgSchema.mcpServerAuditEventsPostgres.serverId, input.serverId),
      );
    }
    if (input.cursor) {
      filters.push(
        lt(pgSchema.mcpServerAuditEventsPostgres.createdAt, input.cursor),
      );
    }
    const rows = await this.db
      .select()
      .from(pgSchema.mcpServerAuditEventsPostgres)
      .where(and(...filters))
      .orderBy(desc(pgSchema.mcpServerAuditEventsPostgres.createdAt))
      .limit(normalizeLimit(input.limit));
    return rows.map((row) => this.mapAuditEvent(row));
  }

  private mapServer(
    row: typeof pgSchema.mcpServersPostgres.$inferSelect,
  ): McpServerDefinition {
    return {
      id: row.id as McpServerDefinition['id'],
      appId: row.appId as McpServerDefinition['appId'],
      name: row.name,
      displayName: row.displayName ?? undefined,
      description: row.description ?? undefined,
      status: row.status as McpServerDefinition['status'],
      createdSource: row.createdSource as McpServerDefinition['createdSource'],
      riskClass: row.riskClass as McpServerDefinition['riskClass'],
      requestedBy: row.requestedBy ?? undefined,
      requestedReason: row.requestedReason ?? undefined,
      transport: row.transport as McpServerDefinition['transport'],
      config: parseJsonRecord(
        row.configJson,
      ) as unknown as McpServerDefinition['config'],
      allowedToolPatterns: parseJsonArray(row.allowedToolPatternsJson),
      autoApproveToolPatterns: parseJsonArray(row.autoApproveToolPatternsJson),
      credentialRefs: JSON.parse(
        row.credentialRefsJson || '[]',
      ) as McpServerDefinition['credentialRefs'],
      networkHosts: parseJsonArray(row.networkHostsJson),
      sandboxProfileId: row.sandboxProfileId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      disabledBy: row.disabledBy ?? undefined,
      disabledAt: row.disabledAt ?? undefined,
    };
  }

  private mapBinding(
    row: typeof pgSchema.agentMcpServerBindingsPostgres.$inferSelect,
  ): AgentMcpServerBinding {
    return {
      id: row.id as AgentMcpServerBinding['id'],
      appId: row.appId as AgentMcpServerBinding['appId'],
      agentId: row.agentId as AgentMcpServerBinding['agentId'],
      serverId: row.serverId as AgentMcpServerBinding['serverId'],
      status: row.status as AgentMcpServerBinding['status'],
      required: row.required,
      permissionPolicyIds: parseJsonArray(
        row.permissionPolicyIdsJson,
      ) as AgentMcpServerBinding['permissionPolicyIds'],
      allowedToolPatterns: parseJsonArray(row.allowedToolPatternsJson),
      conversationId:
        row.conversationId as AgentMcpServerBinding['conversationId'],
      threadId: row.threadId as AgentMcpServerBinding['threadId'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapAuditEvent(
    row: typeof pgSchema.mcpServerAuditEventsPostgres.$inferSelect,
  ): McpServerAuditEvent {
    return {
      id: row.id as McpServerAuditEvent['id'],
      appId: row.appId as McpServerAuditEvent['appId'],
      agentId: row.agentId as McpServerAuditEvent['agentId'],
      serverId: row.serverId as McpServerAuditEvent['serverId'],
      bindingId: row.bindingId as McpServerAuditEvent['bindingId'],
      eventType: row.eventType as McpServerAuditEvent['eventType'],
      actorId: row.actorId ?? undefined,
      reason: row.reason ?? undefined,
      metadata: parseJsonRecord(row.metadataJson),
      createdAt: row.createdAt,
    };
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit) return 100;
  return Math.max(1, Math.min(500, Math.trunc(limit)));
}

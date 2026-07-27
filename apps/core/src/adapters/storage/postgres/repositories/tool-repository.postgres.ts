import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type {
  AgentToolAccessSnapshot,
  ToolCatalogRepository,
} from '../../../../domain/ports/repositories.js';
import type {
  AgentToolBinding,
  AgentToolSource,
  ToolCatalogItem,
} from '../../../../domain/tools/tools.js';
import * as pgSchema from '../schema/schema.js';
import { retryPostgresRead } from '../postgres-read-retry.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return fallback;
  }
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
    toolId: row.tool_id,
    configVersionId: row.config_version_id,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    providerToolName: row.provider_tool_name,
    displayName: row.display_name,
    description: row.description,
    category: row.category,
    inputSchemaJson: row.input_schema_json,
    outputSchemaJson: row.output_schema_json,
    risk: row.risk,
    selectable: row.selectable,
    status: row.status,
    permissionPolicyId: row.permission_policy_id,
    sandboxProfileId: row.sandbox_profile_id,
    adapterRef: row.adapter_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresToolCatalogRepository implements ToolCatalogRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getTool(id: ToolCatalogItem['id']): Promise<ToolCatalogItem | null> {
    const rows = await retryPostgresRead('tool_catalog.getTool', () =>
      this.db
        .select()
        .from(pgSchema.toolCatalogPostgres)
        .where(eq(pgSchema.toolCatalogPostgres.id, id))
        .limit(1),
    );
    return rows[0] ? this.mapTool(rows[0]) : null;
  }

  async listTools(input: {
    appId: ToolCatalogItem['appId'];
    statuses?: ToolCatalogItem['status'][];
  }): Promise<ToolCatalogItem[]> {
    const filters: SQL[] = [
      eq(pgSchema.toolCatalogPostgres.appId, input.appId),
    ];
    if (input.statuses?.length) {
      filters.push(
        inArray(pgSchema.toolCatalogPostgres.status, input.statuses),
      );
    }
    const rows = await retryPostgresRead('tool_catalog.listTools', () =>
      this.db
        .select()
        .from(pgSchema.toolCatalogPostgres)
        .where(and(...filters))
        .orderBy(asc(pgSchema.toolCatalogPostgres.displayName)),
    );
    return rows.map((row) => this.mapTool(row));
  }

  async saveTool(item: ToolCatalogItem): Promise<void> {
    await this.db
      .insert(pgSchema.toolCatalogPostgres)
      .values(toolToRow(item))
      .onConflictDoUpdate({
        target: pgSchema.toolCatalogPostgres.id,
        set: {
          ...toolToRow(item),
          id: undefined,
          appId: undefined,
          createdAt: undefined,
        },
      });
  }

  async saveAgentToolBinding(binding: AgentToolBinding): Promise<void> {
    await this.db
      .insert(pgSchema.agentToolBindingsPostgres)
      .values({
        id: binding.id,
        appId: binding.appId,
        agentId: binding.agentId,
        toolId: binding.toolId,
        configVersionId: binding.configVersionId ?? null,
        status: binding.status,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentToolBindingsPostgres.id,
        set: {
          configVersionId: binding.configVersionId ?? null,
          status: binding.status,
          updatedAt: binding.updatedAt,
        },
      });
  }

  async disableAgentToolBinding(input: {
    appId: AgentToolBinding['appId'];
    agentId: AgentToolBinding['agentId'];
    toolId: AgentToolBinding['toolId'];
    updatedAt: string;
  }): Promise<AgentToolBinding | null> {
    const rows = await this.db
      .update(pgSchema.agentToolBindingsPostgres)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(pgSchema.agentToolBindingsPostgres.appId, input.appId),
          eq(pgSchema.agentToolBindingsPostgres.agentId, input.agentId),
          eq(pgSchema.agentToolBindingsPostgres.toolId, input.toolId),
        ),
      )
      .returning();
    return rows[0] ? this.mapBinding(rows[0]) : null;
  }

  async listAgentToolBindings(input: {
    appId: AgentToolBinding['appId'];
    agentId: AgentToolBinding['agentId'];
  }): Promise<AgentToolBinding[]> {
    return this.listAgentToolBindingRows(input);
  }

  async listAgentToolAccessSnapshot(input: {
    appId: AgentToolBinding['appId'];
    agentId: AgentToolBinding['agentId'];
  }): Promise<AgentToolAccessSnapshot> {
    const result = await retryPostgresRead('agent_tool_access.snapshot', () =>
      this.db.execute<{
        active_bindings: unknown;
        app_active_definitions: unknown;
      }>(sql`
        SELECT
          (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'binding', to_jsonb(b),
              'definition', CASE WHEN t.id IS NULL THEN NULL ELSE to_jsonb(t) END
            ) ORDER BY b.created_at), '[]'::jsonb)
            FROM agent_tool_bindings b
            LEFT JOIN tool_catalog t
              ON t.id = b.tool_id
             AND t.app_id = ${input.appId}
            WHERE b.app_id = ${input.appId}
              AND b.agent_id = ${input.agentId}
              AND b.status = 'active'
          ) AS active_bindings,
          (
            SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.display_name), '[]'::jsonb)
            FROM tool_catalog t
            WHERE t.app_id = ${input.appId}
              AND t.status = 'active'
          ) AS app_active_definitions
      `),
    );
    const row = result.rows[0];
    return {
      activeBindings: jsonArray(row?.active_bindings).map((entry) => ({
        binding: this.mapBinding(fromDbJson(entry.binding) as never),
        definition: entry.definition
          ? this.mapTool(fromDbJson(entry.definition) as never)
          : null,
      })),
      appActiveDefinitions: jsonArray(row?.app_active_definitions).map((tool) =>
        this.mapTool(fromDbJson(tool) as never),
      ),
    };
  }

  async listAgentToolBindingsForAgents(input: {
    appId: AgentToolBinding['appId'];
    agentIds: readonly AgentToolBinding['agentId'][];
  }): Promise<AgentToolBinding[]> {
    return this.listAgentToolBindingRows(input);
  }

  async replaceAgentToolSources(input: {
    appId: AgentToolSource['appId'];
    agentId: AgentToolSource['agentId'];
    sources: AgentToolSource[];
    updatedAt: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existingSources = await tx
        .select()
        .from(pgSchema.agentToolSourcesPostgres)
        .where(
          and(
            eq(pgSchema.agentToolSourcesPostgres.appId, input.appId),
            eq(pgSchema.agentToolSourcesPostgres.agentId, input.agentId),
          ),
        );
      const nextSourceIds = new Set(
        input.sources.map((source) => String(source.id)),
      );
      for (const source of existingSources) {
        if (nextSourceIds.has(String(source.id))) continue;
        await tx
          .update(pgSchema.agentToolSourcesPostgres)
          .set({ status: 'disabled', updatedAt: input.updatedAt })
          .where(eq(pgSchema.agentToolSourcesPostgres.id, source.id));
      }
      for (const source of input.sources) {
        await tx
          .insert(pgSchema.agentToolSourcesPostgres)
          .values({
            id: source.id,
            appId: source.appId,
            agentId: source.agentId,
            sourceId: source.sourceId,
            kind: source.kind,
            version: source.version,
            status: source.status,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
          })
          .onConflictDoUpdate({
            target: pgSchema.agentToolSourcesPostgres.id,
            set: {
              sourceId: source.sourceId,
              kind: source.kind,
              version: source.version,
              status: source.status,
              updatedAt: source.updatedAt,
            },
          });
      }
    });
  }

  async listAgentToolSources(input: {
    appId: AgentToolSource['appId'];
    agentId: AgentToolSource['agentId'];
  }): Promise<AgentToolSource[]> {
    return this.listAgentToolSourceRows(input);
  }

  async listAgentToolSourcesForAgents(input: {
    appId: AgentToolSource['appId'];
    agentIds: readonly AgentToolSource['agentId'][];
  }): Promise<AgentToolSource[]> {
    return this.listAgentToolSourceRows(input);
  }

  private async listAgentToolBindingRows(input: {
    appId: AgentToolBinding['appId'];
    agentId?: AgentToolBinding['agentId'];
    agentIds?: readonly AgentToolBinding['agentId'][];
  }): Promise<AgentToolBinding[]> {
    if (input.agentIds?.length === 0) return [];
    const rows = await retryPostgresRead('agent_tool_bindings.list', () =>
      this.db
        .select()
        .from(pgSchema.agentToolBindingsPostgres)
        .where(
          and(
            eq(pgSchema.agentToolBindingsPostgres.appId, input.appId),
            input.agentId
              ? eq(pgSchema.agentToolBindingsPostgres.agentId, input.agentId)
              : undefined,
            input.agentIds?.length
              ? inArray(pgSchema.agentToolBindingsPostgres.agentId, [
                  ...input.agentIds,
                ])
              : undefined,
          ),
        )
        .orderBy(
          asc(pgSchema.agentToolBindingsPostgres.agentId),
          asc(pgSchema.agentToolBindingsPostgres.createdAt),
        ),
    );
    return rows.map((row) => this.mapBinding(row));
  }

  private async listAgentToolSourceRows(input: {
    appId: AgentToolSource['appId'];
    agentId?: AgentToolSource['agentId'];
    agentIds?: readonly AgentToolSource['agentId'][];
  }): Promise<AgentToolSource[]> {
    if (input.agentIds?.length === 0) return [];
    const rows = await retryPostgresRead('agent_tool_sources.list', () =>
      this.db
        .select()
        .from(pgSchema.agentToolSourcesPostgres)
        .where(
          and(
            eq(pgSchema.agentToolSourcesPostgres.appId, input.appId),
            input.agentId
              ? eq(pgSchema.agentToolSourcesPostgres.agentId, input.agentId)
              : undefined,
            input.agentIds?.length
              ? inArray(pgSchema.agentToolSourcesPostgres.agentId, [
                  ...input.agentIds,
                ])
              : undefined,
          ),
        )
        .orderBy(
          asc(pgSchema.agentToolSourcesPostgres.agentId),
          asc(pgSchema.agentToolSourcesPostgres.sourceId),
        ),
    );
    return rows.map((row) => this.mapSource(row));
  }

  private mapTool(
    row: typeof pgSchema.toolCatalogPostgres.$inferSelect,
  ): ToolCatalogItem {
    return {
      id: row.id,
      appId: row.appId,
      name: row.name,
      kind: row.kind,
      provider: row.provider,
      providerToolName: row.providerToolName ?? undefined,
      displayName: row.displayName || row.name,
      description: row.description ?? undefined,
      category: row.category,
      inputSchema: parseJson(row.inputSchemaJson, undefined),
      outputSchema: parseJson(row.outputSchemaJson, undefined),
      risk: row.risk,
      selectable: row.selectable,
      status: row.status,
      permissionPolicyId: row.permissionPolicyId ?? undefined,
      sandboxProfileId: row.sandboxProfileId ?? undefined,
      adapterRef: row.adapterRef,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as ToolCatalogItem;
  }

  private mapBinding(
    row: typeof pgSchema.agentToolBindingsPostgres.$inferSelect,
  ): AgentToolBinding {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      toolId: row.toolId,
      configVersionId: row.configVersionId ?? undefined,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as AgentToolBinding;
  }

  private mapSource(
    row: typeof pgSchema.agentToolSourcesPostgres.$inferSelect,
  ): AgentToolSource {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      sourceId: row.sourceId,
      kind: row.kind,
      version: row.version,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as AgentToolSource;
  }
}

function toolToRow(item: ToolCatalogItem) {
  return {
    id: item.id,
    appId: item.appId,
    name: item.name,
    kind: item.kind,
    provider: item.provider,
    providerToolName: item.providerToolName ?? null,
    displayName: item.displayName,
    description: item.description ?? null,
    category: item.category,
    inputSchemaJson: encodeJson(item.inputSchema ?? {}),
    outputSchemaJson: encodeJson(item.outputSchema ?? {}),
    risk: item.risk,
    selectable: item.selectable,
    status: item.status,
    permissionPolicyId: item.permissionPolicyId ?? null,
    sandboxProfileId: item.sandboxProfileId ?? null,
    adapterRef: item.adapterRef,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

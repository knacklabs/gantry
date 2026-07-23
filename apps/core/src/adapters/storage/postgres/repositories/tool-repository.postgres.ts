import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';

import type { ToolCatalogRepository } from '../../../../domain/ports/repositories.js';
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

import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';

import type { SkillCatalogRepository } from '../../../../domain/ports/repositories.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
} from '../../../../domain/skills/skills.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonArray<T = string>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return [];
  }
}

export class PostgresSkillCatalogRepository implements SkillCatalogRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getSkill(id: SkillCatalogItem['id']): Promise<SkillCatalogItem | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.skillCatalogPostgres)
      .where(eq(pgSchema.skillCatalogPostgres.id, id))
      .limit(1);
    const row = rows[0];
    return row ? this.mapSkill(row) : null;
  }

  async listSkills(input: {
    appId: SkillCatalogItem['appId'];
    agentId?: SkillCatalogItem['agentId'];
    statuses?: SkillCatalogItem['status'][];
  }): Promise<SkillCatalogItem[]> {
    const filters: SQL[] = [
      eq(pgSchema.skillCatalogPostgres.appId, input.appId),
    ];
    if (input.agentId) {
      filters.push(eq(pgSchema.skillCatalogPostgres.agentId, input.agentId));
    }
    if (input.statuses?.length) {
      filters.push(
        inArray(pgSchema.skillCatalogPostgres.status, input.statuses),
      );
    }
    const rows = await this.db
      .select()
      .from(pgSchema.skillCatalogPostgres)
      .where(and(...filters))
      .orderBy(desc(pgSchema.skillCatalogPostgres.updatedAt));
    return rows.map((row) => this.mapSkill(row));
  }

  async saveSkill(item: SkillCatalogItem): Promise<void> {
    await this.db
      .insert(pgSchema.skillCatalogPostgres)
      .values({
        id: item.id,
        appId: item.appId,
        agentId: item.agentId ?? null,
        name: item.name,
        description: item.description ?? null,
        source: item.source,
        status: item.status,
        promptRefsJson: encodeJson(item.promptRefs),
        toolIdsJson: encodeJson(item.toolIds),
        workflowRefsJson: encodeJson(item.workflowRefs),
        requiredEnvVarsJson: encodeJson(item.requiredEnvVars ?? []),
        actionPermissionsJson: item.actionPermissions ?? [],
        storageType: item.storage?.storageType ?? null,
        storageRef: item.storage?.storageRef ?? null,
        contentHash: item.storage?.contentHash ?? null,
        sizeBytes: item.storage?.sizeBytes ?? null,
        createdBy: item.createdBy ?? null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.skillCatalogPostgres.id,
        set: {
          agentId: item.agentId ?? null,
          name: item.name,
          description: item.description ?? null,
          source: item.source,
          status: item.status,
          promptRefsJson: encodeJson(item.promptRefs),
          toolIdsJson: encodeJson(item.toolIds),
          workflowRefsJson: encodeJson(item.workflowRefs),
          requiredEnvVarsJson: encodeJson(item.requiredEnvVars ?? []),
          actionPermissionsJson: item.actionPermissions ?? [],
          storageType: item.storage?.storageType ?? null,
          storageRef: item.storage?.storageRef ?? null,
          contentHash: item.storage?.contentHash ?? null,
          sizeBytes: item.storage?.sizeBytes ?? null,
          createdBy: item.createdBy ?? null,
          updatedAt: item.updatedAt,
        },
      });
  }

  async saveAgentSkillBinding(binding: AgentSkillBinding): Promise<void> {
    await this.db
      .insert(pgSchema.agentSkillBindingsPostgres)
      .values({
        id: binding.id,
        appId: binding.appId,
        agentId: binding.agentId,
        skillId: binding.skillId,
        configVersionId: binding.configVersionId ?? null,
        status: binding.status,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentSkillBindingsPostgres.id,
        set: {
          configVersionId: binding.configVersionId ?? null,
          status: binding.status,
          updatedAt: binding.updatedAt,
        },
      });
  }

  async disableAgentSkillBinding(input: {
    appId: AgentSkillBinding['appId'];
    agentId: AgentSkillBinding['agentId'];
    skillId: AgentSkillBinding['skillId'];
    updatedAt: string;
  }): Promise<AgentSkillBinding | null> {
    const rows = await this.db
      .update(pgSchema.agentSkillBindingsPostgres)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(pgSchema.agentSkillBindingsPostgres.appId, input.appId),
          eq(pgSchema.agentSkillBindingsPostgres.agentId, input.agentId),
          eq(pgSchema.agentSkillBindingsPostgres.skillId, input.skillId),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? this.mapBinding(row) : null;
  }

  async listAgentSkillBindings(input: {
    appId: AgentSkillBinding['appId'];
    agentId: AgentSkillBinding['agentId'];
  }): Promise<AgentSkillBinding[]> {
    return this.listAgentSkillBindingRows(input);
  }

  async listAgentSkillBindingsForAgents(input: {
    appId: AgentSkillBinding['appId'];
    agentIds: readonly AgentSkillBinding['agentId'][];
  }): Promise<AgentSkillBinding[]> {
    return this.listAgentSkillBindingRows(input);
  }

  private async listAgentSkillBindingRows(input: {
    appId: AgentSkillBinding['appId'];
    agentId?: AgentSkillBinding['agentId'];
    agentIds?: readonly AgentSkillBinding['agentId'][];
  }): Promise<AgentSkillBinding[]> {
    if (input.agentIds?.length === 0) return [];
    const rows = await this.db
      .select()
      .from(pgSchema.agentSkillBindingsPostgres)
      .where(
        and(
          eq(pgSchema.agentSkillBindingsPostgres.appId, input.appId),
          input.agentId
            ? eq(pgSchema.agentSkillBindingsPostgres.agentId, input.agentId)
            : undefined,
          input.agentIds?.length
            ? inArray(pgSchema.agentSkillBindingsPostgres.agentId, [
                ...input.agentIds,
              ])
            : undefined,
        ),
      )
      .orderBy(
        asc(pgSchema.agentSkillBindingsPostgres.agentId),
        asc(pgSchema.agentSkillBindingsPostgres.createdAt),
      );
    return rows.map((row) => this.mapBinding(row));
  }

  async listEnabledSkillsForAgent(input: {
    appId: AgentSkillBinding['appId'];
    agentId: AgentSkillBinding['agentId'];
  }): Promise<SkillCatalogItem[]> {
    const rows = await this.db
      .select({ skill: pgSchema.skillCatalogPostgres })
      .from(pgSchema.agentSkillBindingsPostgres)
      .innerJoin(
        pgSchema.skillCatalogPostgres,
        eq(
          pgSchema.agentSkillBindingsPostgres.skillId,
          pgSchema.skillCatalogPostgres.id,
        ),
      )
      .where(
        and(
          eq(pgSchema.agentSkillBindingsPostgres.appId, input.appId),
          eq(pgSchema.agentSkillBindingsPostgres.agentId, input.agentId),
          eq(pgSchema.agentSkillBindingsPostgres.status, 'active'),
          eq(pgSchema.skillCatalogPostgres.status, 'installed'),
        ),
      )
      .orderBy(asc(pgSchema.skillCatalogPostgres.name));
    return rows.map((row) => this.mapSkill(row.skill));
  }

  private mapSkill(
    row: typeof pgSchema.skillCatalogPostgres.$inferSelect,
  ): SkillCatalogItem {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId ?? undefined,
      name: row.name,
      description: row.description ?? undefined,
      source: row.source as SkillCatalogItem['source'],
      status: row.status as SkillCatalogItem['status'],
      promptRefs: parseJsonArray(row.promptRefsJson),
      toolIds: parseJsonArray(row.toolIdsJson),
      workflowRefs: parseJsonArray(row.workflowRefsJson),
      requiredEnvVars: parseJsonArray(row.requiredEnvVarsJson),
      actionPermissions: parseJsonArray(row.actionPermissionsJson),
      storage:
        row.storageType && row.storageRef && row.contentHash
          ? {
              storageType: row.storageType as NonNullable<
                SkillCatalogItem['storage']
              >['storageType'],
              storageRef: row.storageRef,
              contentHash: row.contentHash,
              sizeBytes: row.sizeBytes ?? 0,
            }
          : undefined,
      createdBy: row.createdBy ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as SkillCatalogItem;
  }

  private mapBinding(
    row: typeof pgSchema.agentSkillBindingsPostgres.$inferSelect,
  ): AgentSkillBinding {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      skillId: row.skillId,
      configVersionId: row.configVersionId ?? undefined,
      status: row.status as AgentSkillBinding['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as AgentSkillBinding;
  }
}

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
function encodeJson(value) {
    return JSON.stringify(value ?? null);
}
function parseJsonArray(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value !== 'string' || value.length === 0)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (err) {
        if (!(err instanceof SyntaxError))
            throw err;
        return [];
    }
}
export class PostgresSkillCatalogRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getSkill(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.skillCatalogPostgres)
            .where(eq(pgSchema.skillCatalogPostgres.id, id))
            .limit(1);
        const row = rows[0];
        return row ? this.mapSkill(row) : null;
    }
    async listSkills(input) {
        const filters = [
            eq(pgSchema.skillCatalogPostgres.appId, input.appId),
        ];
        if (input.agentId) {
            filters.push(eq(pgSchema.skillCatalogPostgres.agentId, input.agentId));
        }
        if (input.statuses?.length) {
            filters.push(inArray(pgSchema.skillCatalogPostgres.status, input.statuses));
        }
        const rows = await this.db
            .select()
            .from(pgSchema.skillCatalogPostgres)
            .where(and(...filters))
            .orderBy(desc(pgSchema.skillCatalogPostgres.updatedAt));
        return rows.map((row) => this.mapSkill(row));
    }
    async saveSkill(item) {
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
    async saveAgentSkillBinding(binding) {
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
    async disableAgentSkillBinding(input) {
        const rows = await this.db
            .update(pgSchema.agentSkillBindingsPostgres)
            .set({ status: 'disabled', updatedAt: input.updatedAt })
            .where(and(eq(pgSchema.agentSkillBindingsPostgres.appId, input.appId), eq(pgSchema.agentSkillBindingsPostgres.agentId, input.agentId), eq(pgSchema.agentSkillBindingsPostgres.skillId, input.skillId)))
            .returning();
        const row = rows[0];
        return row ? this.mapBinding(row) : null;
    }
    async listAgentSkillBindings(input) {
        return this.listAgentSkillBindingRows(input);
    }
    async listAgentSkillBindingsForAgents(input) {
        return this.listAgentSkillBindingRows(input);
    }
    async listAgentSkillBindingRows(input) {
        if (input.agentIds?.length === 0)
            return [];
        const rows = await this.db
            .select()
            .from(pgSchema.agentSkillBindingsPostgres)
            .where(and(eq(pgSchema.agentSkillBindingsPostgres.appId, input.appId), input.agentId
            ? eq(pgSchema.agentSkillBindingsPostgres.agentId, input.agentId)
            : undefined, input.agentIds?.length
            ? inArray(pgSchema.agentSkillBindingsPostgres.agentId, [
                ...input.agentIds,
            ])
            : undefined))
            .orderBy(asc(pgSchema.agentSkillBindingsPostgres.agentId), asc(pgSchema.agentSkillBindingsPostgres.createdAt));
        return rows.map((row) => this.mapBinding(row));
    }
    async listEnabledSkillsForAgent(input) {
        const rows = await this.db
            .select({ skill: pgSchema.skillCatalogPostgres })
            .from(pgSchema.agentSkillBindingsPostgres)
            .innerJoin(pgSchema.skillCatalogPostgres, eq(pgSchema.agentSkillBindingsPostgres.skillId, pgSchema.skillCatalogPostgres.id))
            .where(and(eq(pgSchema.agentSkillBindingsPostgres.appId, input.appId), eq(pgSchema.agentSkillBindingsPostgres.agentId, input.agentId), eq(pgSchema.agentSkillBindingsPostgres.status, 'active'), eq(pgSchema.skillCatalogPostgres.status, 'installed')))
            .orderBy(asc(pgSchema.skillCatalogPostgres.name));
        return rows.map((row) => this.mapSkill(row.skill));
    }
    mapSkill(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentId: row.agentId ?? undefined,
            name: row.name,
            description: row.description ?? undefined,
            source: row.source,
            status: row.status,
            promptRefs: parseJsonArray(row.promptRefsJson),
            toolIds: parseJsonArray(row.toolIdsJson),
            workflowRefs: parseJsonArray(row.workflowRefsJson),
            requiredEnvVars: parseJsonArray(row.requiredEnvVarsJson),
            actionPermissions: parseJsonArray(row.actionPermissionsJson),
            storage: row.storageType && row.storageRef && row.contentHash
                ? {
                    storageType: row.storageType,
                    storageRef: row.storageRef,
                    contentHash: row.contentHash,
                    sizeBytes: row.sizeBytes ?? 0,
                }
                : undefined,
            createdBy: row.createdBy ?? undefined,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
    mapBinding(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentId: row.agentId,
            skillId: row.skillId,
            configVersionId: row.configVersionId ?? undefined,
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
}

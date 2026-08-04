import { and, asc, eq } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
export class PostgresAgentRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getAgent(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.agentsPostgres)
            .where(eq(pgSchema.agentsPostgres.id, id))
            .limit(1);
        return rows[0] ?? null;
    }
    async listAgents(appId) {
        const rows = await this.db
            .select()
            .from(pgSchema.agentsPostgres)
            .where(eq(pgSchema.agentsPostgres.appId, appId))
            .orderBy(asc(pgSchema.agentsPostgres.name), asc(pgSchema.agentsPostgres.id));
        return rows;
    }
    async saveAgent(agent) {
        await this.db
            .insert(pgSchema.agentsPostgres)
            .values({
            ...agent,
            currentConfigVersionId: agent.currentConfigVersionId ?? null,
        })
            .onConflictDoUpdate({
            target: pgSchema.agentsPostgres.id,
            set: {
                name: agent.name,
                status: agent.status,
                currentConfigVersionId: agent.currentConfigVersionId ?? null,
                updatedAt: agent.updatedAt,
            },
        });
    }
    async replaceAgentCapabilityBindings(input) {
        await this.db.transaction(async (tx) => {
            await this.writeAgentCapabilityBindings(tx, input);
        });
    }
    async replaceAgentAccess(input) {
        await this.db.transaction(async (tx) => {
            await this.writeAgentCapabilityBindings(tx, input);
            await this.writeAgentToolSources(tx, input);
        });
    }
    async writeAgentCapabilityBindings(tx, input) {
        const [existingToolBindings, existingSkillBindings, existingMcpBindings] = await Promise.all([
            tx
                .select()
                .from(pgSchema.agentToolBindingsPostgres)
                .where(and(eq(pgSchema.agentToolBindingsPostgres.appId, input.appId), eq(pgSchema.agentToolBindingsPostgres.agentId, input.agentId))),
            tx
                .select()
                .from(pgSchema.agentSkillBindingsPostgres)
                .where(and(eq(pgSchema.agentSkillBindingsPostgres.appId, input.appId), eq(pgSchema.agentSkillBindingsPostgres.agentId, input.agentId))),
            tx
                .select()
                .from(pgSchema.agentMcpServerBindingsPostgres)
                .where(and(eq(pgSchema.agentMcpServerBindingsPostgres.appId, input.appId), eq(pgSchema.agentMcpServerBindingsPostgres.agentId, input.agentId))),
        ]);
        const nextToolIds = new Set(input.toolBindings.map((binding) => String(binding.id)));
        const nextSkillIds = new Set(input.skillBindings.map((binding) => String(binding.id)));
        const nextMcpIds = new Set(input.mcpBindings.map((binding) => String(binding.id)));
        for (const binding of existingToolBindings) {
            if (nextToolIds.has(String(binding.id)))
                continue;
            await tx
                .update(pgSchema.agentToolBindingsPostgres)
                .set({ status: 'disabled', updatedAt: input.updatedAt })
                .where(eq(pgSchema.agentToolBindingsPostgres.id, binding.id));
        }
        for (const binding of existingSkillBindings) {
            if (nextSkillIds.has(String(binding.id)))
                continue;
            await tx
                .update(pgSchema.agentSkillBindingsPostgres)
                .set({ status: 'disabled', updatedAt: input.updatedAt })
                .where(eq(pgSchema.agentSkillBindingsPostgres.id, binding.id));
        }
        for (const binding of existingMcpBindings) {
            if (nextMcpIds.has(String(binding.id)))
                continue;
            await tx
                .update(pgSchema.agentMcpServerBindingsPostgres)
                .set({ status: 'disabled', updatedAt: input.updatedAt })
                .where(eq(pgSchema.agentMcpServerBindingsPostgres.id, binding.id));
        }
        for (const binding of input.toolBindings) {
            await tx
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
        for (const binding of input.skillBindings) {
            await tx
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
        for (const binding of input.mcpBindings) {
            await tx
                .insert(pgSchema.agentMcpServerBindingsPostgres)
                .values({
                id: binding.id,
                appId: binding.appId,
                agentId: binding.agentId,
                serverId: binding.serverId,
                status: binding.status,
                required: binding.required,
                permissionPolicyIdsJson: JSON.stringify(binding.permissionPolicyIds),
                allowedToolPatternsJson: JSON.stringify(binding.allowedToolPatterns),
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
                    permissionPolicyIdsJson: JSON.stringify(binding.permissionPolicyIds),
                    allowedToolPatternsJson: JSON.stringify(binding.allowedToolPatterns),
                    conversationId: binding.conversationId ?? null,
                    threadId: binding.threadId ?? null,
                    updatedAt: binding.updatedAt,
                },
            });
        }
    }
    async writeAgentToolSources(tx, input) {
        const existingSources = await tx
            .select()
            .from(pgSchema.agentToolSourcesPostgres)
            .where(and(eq(pgSchema.agentToolSourcesPostgres.appId, input.appId), eq(pgSchema.agentToolSourcesPostgres.agentId, input.agentId)));
        const nextSourceIds = new Set(input.toolSources.map((source) => String(source.id)));
        for (const source of existingSources) {
            if (nextSourceIds.has(String(source.id)))
                continue;
            await tx
                .update(pgSchema.agentToolSourcesPostgres)
                .set({ status: 'disabled', updatedAt: input.updatedAt })
                .where(eq(pgSchema.agentToolSourcesPostgres.id, source.id));
        }
        for (const source of input.toolSources) {
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
    }
    async disableAgent(input) {
        const rows = await this.db
            .update(pgSchema.agentsPostgres)
            .set({ status: 'disabled', updatedAt: input.updatedAt })
            .where(and(eq(pgSchema.agentsPostgres.appId, input.appId), eq(pgSchema.agentsPostgres.id, input.agentId)))
            .returning();
        return rows[0] ?? null;
    }
}

import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Agent } from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type { AgentRepository } from '../../../../domain/ports/repositories.js';
import type {
  AgentMcpServerBinding,
  McpBindingAuthorityPrecondition,
} from '../../../../domain/mcp/mcp-servers.js';
import type { AgentSkillBinding } from '../../../../domain/skills/skills.js';
import type {
  AgentToolBinding,
  AgentToolSource,
} from '../../../../domain/tools/tools.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import {
  assertExpectedMcpBindingsUnchanged,
  lockAgentMcpBindingSet,
} from './mcp-binding-authority-fence.postgres.js';

type AgentWriteDb = Parameters<Parameters<CanonicalDb['transaction']>[0]>[0];

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getAgent(id: Agent['id']): Promise<Agent | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentsPostgres)
      .where(eq(pgSchema.agentsPostgres.id, id))
      .limit(1);
    return (rows[0] as Agent | undefined) ?? null;
  }

  async listAgents(appId: App['id']): Promise<Agent[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentsPostgres)
      .where(eq(pgSchema.agentsPostgres.appId, appId))
      .orderBy(
        asc(pgSchema.agentsPostgres.name),
        asc(pgSchema.agentsPostgres.id),
      );
    return rows as Agent[];
  }

  async saveAgent(agent: Agent): Promise<void> {
    await this.saveAgentWithDb(this.db, agent);
  }

  private async saveAgentWithDb(
    db: CanonicalExecutor,
    agent: Agent,
  ): Promise<void> {
    await db
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

  async assertMcpBindingAuthorityPreconditions(input: {
    appId: Agent['appId'];
    expectedMcpBindingAgentIds?: Agent['id'][];
    expectedMcpBindings: McpBindingAuthorityPrecondition[];
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await assertExpectedMcpBindingsUnchanged(tx, input);
    });
  }

  async replaceAgentCapabilityBindings(input: {
    appId: Agent['appId'];
    agentId: Agent['id'];
    toolBindings: AgentToolBinding[];
    skillBindings: AgentSkillBinding[];
    mcpBindings: AgentMcpServerBinding[];
    expectedMcpBindingAgentIds?: Agent['id'][];
    expectedMcpBindings?: McpBindingAuthorityPrecondition[];
    preserveExistingMcpPolicy?: boolean;
    updatedAt: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.writeAgentCapabilityBindings(tx, input);
    });
  }

  async replaceAgentCapabilityBindingsBatch(input: {
    appId: Agent['appId'];
    agents: Agent[];
    replacements: Array<{
      agentId: Agent['id'];
      toolBindings: AgentToolBinding[];
      skillBindings: AgentSkillBinding[];
      mcpBindings: AgentMcpServerBinding[];
      preserveExistingMcpPolicy?: boolean;
      updatedAt: string;
    }>;
    expectedMcpBindingAgentIds: Agent['id'][];
    expectedMcpBindings: McpBindingAuthorityPrecondition[];
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const agent of [...input.agents].sort((left, right) =>
        String(left.id).localeCompare(String(right.id)),
      )) {
        await this.saveAgentWithDb(tx, agent);
      }
      await assertExpectedMcpBindingsUnchanged(tx, input);
      for (const replacement of [...input.replacements].sort((left, right) =>
        String(left.agentId).localeCompare(String(right.agentId)),
      )) {
        await this.writeAgentCapabilityBindings(
          tx,
          { ...replacement, appId: input.appId },
          true,
        );
      }
    });
  }

  async replaceAgentAccess(input: {
    appId: Agent['appId'];
    agentId: Agent['id'];
    toolBindings: AgentToolBinding[];
    skillBindings: AgentSkillBinding[];
    mcpBindings: AgentMcpServerBinding[];
    toolSources: AgentToolSource[];
    updatedAt: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.writeAgentCapabilityBindings(tx, input);
      await this.writeAgentToolSources(tx, input);
    });
  }

  private async writeAgentCapabilityBindings(
    tx: AgentWriteDb,
    input: {
      appId: Agent['appId'];
      agentId: Agent['id'];
      toolBindings: AgentToolBinding[];
      skillBindings: AgentSkillBinding[];
      mcpBindings: AgentMcpServerBinding[];
      expectedMcpBindingAgentIds?: Agent['id'][];
      expectedMcpBindings?: McpBindingAuthorityPrecondition[];
      preserveExistingMcpPolicy?: boolean;
      updatedAt: string;
    },
    mcpFenceAlreadyHeld = false,
  ): Promise<void> {
    if (mcpFenceAlreadyHeld) {
      // The batch path locked and checked the complete multi-agent snapshot.
    } else if (
      (input.expectedMcpBindingAgentIds?.length ?? 0) > 0 ||
      (input.expectedMcpBindings?.length ?? 0) > 0
    ) {
      await assertExpectedMcpBindingsUnchanged(tx, input);
    } else {
      await lockAgentMcpBindingSet(tx, input);
    }
    const [existingToolBindings, existingSkillBindings, existingMcpBindings] =
      await Promise.all([
        tx
          .select()
          .from(pgSchema.agentToolBindingsPostgres)
          .where(
            and(
              eq(pgSchema.agentToolBindingsPostgres.appId, input.appId),
              eq(pgSchema.agentToolBindingsPostgres.agentId, input.agentId),
              isNull(pgSchema.agentToolBindingsPostgres.personId),
            ),
          ),
        tx
          .select()
          .from(pgSchema.agentSkillBindingsPostgres)
          .where(
            and(
              eq(pgSchema.agentSkillBindingsPostgres.appId, input.appId),
              eq(pgSchema.agentSkillBindingsPostgres.agentId, input.agentId),
            ),
          ),
        tx
          .select()
          .from(pgSchema.agentMcpServerBindingsPostgres)
          .where(
            and(
              eq(pgSchema.agentMcpServerBindingsPostgres.appId, input.appId),
              eq(
                pgSchema.agentMcpServerBindingsPostgres.agentId,
                input.agentId,
              ),
            ),
          )
          .for('update'),
      ]);
    const nextToolIds = new Set(
      input.toolBindings.map((binding) => String(binding.id)),
    );
    const nextSkillIds = new Set(
      input.skillBindings.map((binding) => String(binding.id)),
    );
    const nextMcpIds = new Set(
      input.mcpBindings.map((binding) => String(binding.id)),
    );

    for (const binding of existingToolBindings) {
      if (nextToolIds.has(String(binding.id))) continue;
      await tx
        .update(pgSchema.agentToolBindingsPostgres)
        .set({ status: 'disabled', updatedAt: input.updatedAt })
        .where(eq(pgSchema.agentToolBindingsPostgres.id, binding.id));
    }
    for (const binding of existingSkillBindings) {
      if (nextSkillIds.has(String(binding.id))) continue;
      await tx
        .update(pgSchema.agentSkillBindingsPostgres)
        .set({ status: 'disabled', updatedAt: input.updatedAt })
        .where(eq(pgSchema.agentSkillBindingsPostgres.id, binding.id));
    }
    for (const binding of existingMcpBindings) {
      if (nextMcpIds.has(String(binding.id))) continue;
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
          personId: binding.personId ?? null,
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
    const existingMcpById = new Map(
      existingMcpBindings.map((binding) => [String(binding.id), binding]),
    );
    for (const requestedBinding of input.mcpBindings) {
      const existing = existingMcpById.get(String(requestedBinding.id));
      const binding =
        input.preserveExistingMcpPolicy && existing
          ? {
              ...requestedBinding,
              required: existing.required,
              permissionPolicyIds: JSON.parse(
                existing.permissionPolicyIdsJson,
              ) as AgentMcpServerBinding['permissionPolicyIds'],
              conversationId: existing.conversationId ?? undefined,
              threadId: existing.threadId ?? undefined,
            }
          : requestedBinding;
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
            permissionPolicyIdsJson: JSON.stringify(
              binding.permissionPolicyIds,
            ),
            allowedToolPatternsJson: JSON.stringify(
              binding.allowedToolPatterns,
            ),
            conversationId: binding.conversationId ?? null,
            threadId: binding.threadId ?? null,
            updatedAt: binding.updatedAt,
          },
        });
    }
  }

  private async writeAgentToolSources(
    tx: AgentWriteDb,
    input: {
      appId: Agent['appId'];
      agentId: Agent['id'];
      toolSources: AgentToolSource[];
      updatedAt: string;
    },
  ): Promise<void> {
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
      input.toolSources.map((source) => String(source.id)),
    );
    for (const source of existingSources) {
      if (nextSourceIds.has(String(source.id))) continue;
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

  async disableAgent(input: {
    appId: Agent['appId'];
    agentId: Agent['id'];
    updatedAt: string;
  }): Promise<Agent | null> {
    const rows = await this.db
      .update(pgSchema.agentsPostgres)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(pgSchema.agentsPostgres.appId, input.appId),
          eq(pgSchema.agentsPostgres.id, input.agentId),
        ),
      )
      .returning();
    return (rows[0] as Agent | undefined) ?? null;
  }
}

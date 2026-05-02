import { createHash } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import type {
  Agent,
  AgentDmAccess,
  AgentDmApprover,
  AgentPermissionRule,
} from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type { AgentRepository } from '../../../../domain/ports/repositories.js';
import type { AgentMcpServerBinding } from '../../../../domain/mcp/mcp-servers.js';
import type { AgentSkillBinding } from '../../../../domain/skills/skills.js';
import type { AgentToolBinding } from '../../../../domain/tools/tools.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

function safeIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:@-]/g, '_');
}

function agentDmAccessId(
  agentId: string,
  providerId: string,
  externalUserId: string,
): string {
  return `agent-dm:${safeIdPart(agentId)}:${safeIdPart(providerId)}:${safeIdPart(externalUserId)}`;
}

function agentDmApproverId(agentId: string, providerId: string): string {
  return `agent-dm-admin:${safeIdPart(agentId)}:${safeIdPart(providerId)}`;
}

function agentPermissionRuleId(
  agentId: string,
  effect: AgentPermissionRule['effect'],
  rule: string,
): string {
  const hash = createHash('sha256')
    .update(`${agentId}:${effect}:${rule}`)
    .digest('hex')
    .slice(0, 16);
  return `agent-permission-rule:${safeIdPart(agentId)}:${effect}:${hash}`;
}

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

  async listAgentDmAccess(input: {
    appId: App['id'];
    agentId: Agent['id'];
  }): Promise<AgentDmAccess[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentDmAccessPostgres)
      .where(
        and(
          eq(pgSchema.agentDmAccessPostgres.appId, input.appId),
          eq(pgSchema.agentDmAccessPostgres.agentId, input.agentId),
        ),
      )
      .orderBy(
        asc(pgSchema.agentDmAccessPostgres.providerId),
        asc(pgSchema.agentDmAccessPostgres.externalUserId),
      );
    return rows as AgentDmAccess[];
  }

  async replaceAgentDmAccess(input: {
    appId: App['id'];
    agentId: Agent['id'];
    entries: Array<{ providerId: string; externalUserId: string }>;
    updatedAt: string;
  }): Promise<AgentDmAccess[]> {
    return this.db.transaction(async (tx) => {
      await this.replaceAgentDmAccessRows(input, tx);
      return this.listAgentDmAccessRows(input, tx);
    });
  }

  async replaceAgentDmAccessPolicy(input: {
    appId: App['id'];
    agentId: Agent['id'];
    accessEntries: Array<{ providerId: string; externalUserId: string }>;
    approverEntries: Array<{ providerId: string; externalUserId: string }>;
    updatedAt: string;
  }): Promise<{ access: AgentDmAccess[]; approvers: AgentDmApprover[] }> {
    return this.db.transaction(async (tx) => {
      await this.replaceAgentDmAccessRows(
        {
          appId: input.appId,
          agentId: input.agentId,
          entries: input.accessEntries,
          updatedAt: input.updatedAt,
        },
        tx,
      );
      await this.replaceAgentDmApproverRows(
        {
          appId: input.appId,
          agentId: input.agentId,
          entries: input.approverEntries,
          updatedAt: input.updatedAt,
        },
        tx,
      );
      const [access, approvers] = await Promise.all([
        this.listAgentDmAccessRows(input, tx),
        this.listAgentDmApproverRows(input, tx),
      ]);
      return { access, approvers };
    });
  }

  async replaceAgentCapabilityBindings(input: {
    appId: Agent['appId'];
    agentId: Agent['id'];
    toolBindings: AgentToolBinding[];
    skillBindings: AgentSkillBinding[];
    mcpBindings: AgentMcpServerBinding[];
    updatedAt: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existingToolBindings, existingSkillBindings, existingMcpBindings] =
        await Promise.all([
          tx
            .select()
            .from(pgSchema.agentToolBindingsPostgres)
            .where(
              and(
                eq(pgSchema.agentToolBindingsPostgres.appId, input.appId),
                eq(pgSchema.agentToolBindingsPostgres.agentId, input.agentId),
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
            ),
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
            versionId: binding.versionId,
            status: binding.status,
            required: binding.required,
            permissionPolicyIdsJson: JSON.stringify(
              binding.permissionPolicyIds,
            ),
            conversationId: binding.conversationId ?? null,
            threadId: binding.threadId ?? null,
            createdAt: binding.createdAt,
            updatedAt: binding.updatedAt,
          })
          .onConflictDoUpdate({
            target: pgSchema.agentMcpServerBindingsPostgres.id,
            set: {
              versionId: binding.versionId,
              status: binding.status,
              required: binding.required,
              permissionPolicyIdsJson: JSON.stringify(
                binding.permissionPolicyIds,
              ),
              conversationId: binding.conversationId ?? null,
              threadId: binding.threadId ?? null,
              updatedAt: binding.updatedAt,
            },
          });
      }
    });
  }

  async listAgentPermissionRules(input: {
    appId: Agent['appId'];
    agentId: Agent['id'];
  }): Promise<AgentPermissionRule[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentPermissionRulesPostgres)
      .where(
        and(
          eq(pgSchema.agentPermissionRulesPostgres.appId, input.appId),
          eq(pgSchema.agentPermissionRulesPostgres.agentId, input.agentId),
        ),
      )
      .orderBy(
        asc(pgSchema.agentPermissionRulesPostgres.effect),
        asc(pgSchema.agentPermissionRulesPostgres.rule),
      );
    return rows as AgentPermissionRule[];
  }

  async replaceAgentPermissionRules(input: {
    appId: Agent['appId'];
    agentId: Agent['id'];
    rules: Array<Pick<AgentPermissionRule, 'effect' | 'rule'>>;
    updatedAt: string;
  }): Promise<AgentPermissionRule[]> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(pgSchema.agentPermissionRulesPostgres)
        .where(
          and(
            eq(pgSchema.agentPermissionRulesPostgres.appId, input.appId),
            eq(pgSchema.agentPermissionRulesPostgres.agentId, input.agentId),
          ),
        );
      for (const rule of input.rules) {
        await tx.insert(pgSchema.agentPermissionRulesPostgres).values({
          id: agentPermissionRuleId(input.agentId, rule.effect, rule.rule),
          appId: input.appId,
          agentId: input.agentId,
          effect: rule.effect,
          rule: rule.rule,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        });
      }
      const rows = await tx
        .select()
        .from(pgSchema.agentPermissionRulesPostgres)
        .where(
          and(
            eq(pgSchema.agentPermissionRulesPostgres.appId, input.appId),
            eq(pgSchema.agentPermissionRulesPostgres.agentId, input.agentId),
          ),
        )
        .orderBy(
          asc(pgSchema.agentPermissionRulesPostgres.effect),
          asc(pgSchema.agentPermissionRulesPostgres.rule),
        );
      return rows as AgentPermissionRule[];
    });
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

  async findAgentsByDmAccess(input: {
    appId: App['id'];
    providerId: string;
    externalUserId: string;
  }): Promise<Agent[]> {
    const rows = await this.db
      .select({ agent: pgSchema.agentsPostgres })
      .from(pgSchema.agentDmAccessPostgres)
      .innerJoin(
        pgSchema.agentsPostgres,
        eq(pgSchema.agentsPostgres.id, pgSchema.agentDmAccessPostgres.agentId),
      )
      .where(
        and(
          eq(pgSchema.agentDmAccessPostgres.appId, input.appId),
          eq(pgSchema.agentDmAccessPostgres.providerId, input.providerId),
          eq(
            pgSchema.agentDmAccessPostgres.externalUserId,
            input.externalUserId,
          ),
          eq(pgSchema.agentsPostgres.status, 'active'),
        ),
      )
      .orderBy(
        asc(pgSchema.agentsPostgres.name),
        asc(pgSchema.agentsPostgres.id),
      );
    return rows.map((row) => row.agent as Agent);
  }

  async listAgentDmApprovers(input: {
    appId: App['id'];
    agentId: Agent['id'];
  }): Promise<AgentDmApprover[]> {
    return this.listAgentDmApproverRows(input);
  }

  private async listAgentDmAccessRows(
    input: {
      appId: App['id'];
      agentId: Agent['id'];
    },
    db: CanonicalDb = this.db,
  ): Promise<AgentDmAccess[]> {
    const rows = await db
      .select()
      .from(pgSchema.agentDmAccessPostgres)
      .where(
        and(
          eq(pgSchema.agentDmAccessPostgres.appId, input.appId),
          eq(pgSchema.agentDmAccessPostgres.agentId, input.agentId),
        ),
      )
      .orderBy(
        asc(pgSchema.agentDmAccessPostgres.providerId),
        asc(pgSchema.agentDmAccessPostgres.externalUserId),
      );
    return rows as AgentDmAccess[];
  }

  private async listAgentDmApproverRows(
    input: {
      appId: App['id'];
      agentId: Agent['id'];
    },
    db: CanonicalDb = this.db,
  ): Promise<AgentDmApprover[]> {
    const rows = await db
      .select()
      .from(pgSchema.agentDmApproversPostgres)
      .where(
        and(
          eq(pgSchema.agentDmApproversPostgres.appId, input.appId),
          eq(pgSchema.agentDmApproversPostgres.agentId, input.agentId),
        ),
      )
      .orderBy(asc(pgSchema.agentDmApproversPostgres.providerId));
    return rows as AgentDmApprover[];
  }

  async replaceAgentDmApprovers(input: {
    appId: App['id'];
    agentId: Agent['id'];
    entries: Array<{ providerId: string; externalUserId: string }>;
    updatedAt: string;
  }): Promise<AgentDmApprover[]> {
    return this.db.transaction(async (tx) => {
      await this.replaceAgentDmApproverRows(input, tx);
      return this.listAgentDmApproverRows(input, tx);
    });
  }

  private async replaceAgentDmAccessRows(
    input: {
      appId: App['id'];
      agentId: Agent['id'];
      entries: Array<{ providerId: string; externalUserId: string }>;
      updatedAt: string;
    },
    db: CanonicalDb = this.db,
  ): Promise<void> {
    await db
      .delete(pgSchema.agentDmAccessPostgres)
      .where(
        and(
          eq(pgSchema.agentDmAccessPostgres.appId, input.appId),
          eq(pgSchema.agentDmAccessPostgres.agentId, input.agentId),
        ),
      );
    if (input.entries.length === 0) return;
    await db.insert(pgSchema.agentDmAccessPostgres).values(
      input.entries.map((entry) => ({
        id: agentDmAccessId(
          input.agentId,
          entry.providerId,
          entry.externalUserId,
        ),
        appId: input.appId,
        agentId: input.agentId,
        providerId: entry.providerId,
        externalUserId: entry.externalUserId,
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
      })),
    );
  }

  private async replaceAgentDmApproverRows(
    input: {
      appId: App['id'];
      agentId: Agent['id'];
      entries: Array<{ providerId: string; externalUserId: string }>;
      updatedAt: string;
    },
    db: CanonicalDb = this.db,
  ): Promise<void> {
    await db
      .delete(pgSchema.agentDmApproversPostgres)
      .where(
        and(
          eq(pgSchema.agentDmApproversPostgres.appId, input.appId),
          eq(pgSchema.agentDmApproversPostgres.agentId, input.agentId),
        ),
      );
    if (input.entries.length === 0) return;
    await db.insert(pgSchema.agentDmApproversPostgres).values(
      input.entries.map((entry) => ({
        id: agentDmApproverId(input.agentId, entry.providerId),
        appId: input.appId,
        agentId: input.agentId,
        providerId: entry.providerId,
        externalUserId: entry.externalUserId,
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
      })),
    );
  }
}

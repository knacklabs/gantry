import { and, asc, eq } from 'drizzle-orm';

import type {
  Agent,
  AgentDmAccess,
  AgentDmApprover,
} from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type { AgentRepository } from '../../../../domain/ports/repositories.js';
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
    await this.db.transaction((tx) => this.replaceAgentDmAccessRows(input, tx));
    return this.listAgentDmAccess(input);
  }

  async replaceAgentDmAccessPolicy(input: {
    appId: App['id'];
    agentId: Agent['id'];
    accessEntries: Array<{ providerId: string; externalUserId: string }>;
    approverEntries: Array<{ providerId: string; externalUserId: string }>;
    updatedAt: string;
  }): Promise<{ access: AgentDmAccess[]; approvers: AgentDmApprover[] }> {
    await this.db.transaction(async (tx) => {
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
    });
    const [access, approvers] = await Promise.all([
      this.listAgentDmAccess(input),
      this.listAgentDmApprovers(input),
    ]);
    return { access, approvers };
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
    const rows = await this.db
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
    await this.db.transaction((tx) =>
      this.replaceAgentDmApproverRows(input, tx),
    );
    return this.listAgentDmApprovers(input);
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

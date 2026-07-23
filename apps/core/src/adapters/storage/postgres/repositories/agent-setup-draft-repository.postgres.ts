import { and, asc, eq } from 'drizzle-orm';

import type { AgentSetupDraft } from '../../../../domain/agent/agent-setup-draft.js';
import type { AgentSetupDraftRepository } from '../../../../domain/ports/repositories.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export class PostgresAgentSetupDraftRepository implements AgentSetupDraftRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getDraft(input: {
    appId: AgentSetupDraft['appId'];
    agentId: AgentSetupDraft['agentId'];
  }): Promise<AgentSetupDraft | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentSetupDraftsPostgres)
      .where(
        and(
          eq(pgSchema.agentSetupDraftsPostgres.appId, input.appId),
          eq(pgSchema.agentSetupDraftsPostgres.agentId, input.agentId),
        ),
      )
      .limit(1);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listDrafts(
    appId: AgentSetupDraft['appId'],
  ): Promise<AgentSetupDraft[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentSetupDraftsPostgres)
      .where(eq(pgSchema.agentSetupDraftsPostgres.appId, appId))
      .orderBy(asc(pgSchema.agentSetupDraftsPostgres.updatedAt));
    return rows.map(mapRow);
  }

  async saveDraft(draft: AgentSetupDraft): Promise<void> {
    await this.db
      .insert(pgSchema.agentSetupDraftsPostgres)
      .values({
        ...draft,
        purpose: draft.purpose ?? null,
        modelAlias: draft.modelAlias ?? null,
        connectionJson: draft.connection ?? null,
        conversationJson: draft.conversation ?? null,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentSetupDraftsPostgres.agentId,
        set: {
          purpose: draft.purpose ?? null,
          modelAlias: draft.modelAlias ?? null,
          connectionJson: draft.connection ?? null,
          conversationJson: draft.conversation ?? null,
          currentStage: draft.currentStage,
          version: draft.version,
          updatedAt: draft.updatedAt,
        },
      });
  }

  async deleteDraft(input: {
    appId: AgentSetupDraft['appId'];
    agentId: AgentSetupDraft['agentId'];
  }): Promise<boolean> {
    const rows = await this.db
      .delete(pgSchema.agentSetupDraftsPostgres)
      .where(
        and(
          eq(pgSchema.agentSetupDraftsPostgres.appId, input.appId),
          eq(pgSchema.agentSetupDraftsPostgres.agentId, input.agentId),
        ),
      )
      .returning({ agentId: pgSchema.agentSetupDraftsPostgres.agentId });
    return rows.length > 0;
  }
}

function mapRow(
  row: typeof pgSchema.agentSetupDraftsPostgres.$inferSelect,
): AgentSetupDraft {
  return {
    appId: row.appId as AgentSetupDraft['appId'],
    agentId: row.agentId as AgentSetupDraft['agentId'],
    purpose: row.purpose ?? undefined,
    modelAlias: row.modelAlias ?? undefined,
    connection: asRecord(row.connectionJson),
    conversation: asRecord(row.conversationJson),
    currentStage: row.currentStage as AgentSetupDraft['currentStage'],
    version: row.version,
    createdAt: row.createdAt as AgentSetupDraft['createdAt'],
    updatedAt: row.updatedAt as AgentSetupDraft['updatedAt'],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

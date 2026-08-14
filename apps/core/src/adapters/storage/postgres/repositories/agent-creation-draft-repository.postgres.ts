import { and, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import type { AgentCreationDraft } from '../../../../domain/agent-creation/agent-creation-draft.js';
import type { AgentCreationDraftRepository } from '../../../../domain/ports/agent-creation-drafts.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

type DraftRow = typeof pgSchema.agentCreationDraftsPostgres.$inferSelect;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toDraft(row: DraftRow): AgentCreationDraft {
  return {
    id: row.id as AgentCreationDraft['id'],
    appId: row.appId as AgentCreationDraft['appId'],
    revision: row.revision,
    status: row.status as AgentCreationDraft['status'],
    currentStep: row.currentStep,
    document: asRecord(row.documentJson),
    progress: asRecord(row.progressJson),
    ...(row.agentId
      ? { agentId: row.agentId as AgentCreationDraft['agentId'] }
      : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    ...(row.leaseExpiresAt
      ? {
          leaseExpiresAt:
            row.leaseExpiresAt as AgentCreationDraft['leaseExpiresAt'],
        }
      : {}),
    createdAt: row.createdAt as AgentCreationDraft['createdAt'],
    updatedAt: row.updatedAt as AgentCreationDraft['updatedAt'],
    ...(row.completedAt
      ? { completedAt: row.completedAt as AgentCreationDraft['completedAt'] }
      : {}),
  };
}

function valuesFor(draft: AgentCreationDraft) {
  return {
    status: draft.status,
    currentStep: draft.currentStep,
    documentJson: draft.document,
    progressJson: draft.progress,
    agentId: draft.agentId ?? null,
    jobId: draft.jobId ?? null,
    errorCode: draft.errorCode ?? null,
    errorMessage: draft.errorMessage ?? null,
    leaseToken: draft.leaseToken ?? null,
    leaseExpiresAt: draft.leaseExpiresAt ?? null,
    updatedAt: draft.updatedAt,
    completedAt: draft.completedAt ?? null,
  };
}

export class PostgresAgentCreationDraftRepository implements AgentCreationDraftRepository {
  constructor(private readonly db: CanonicalDb) {}

  async listDrafts(
    appId: AgentCreationDraft['appId'],
  ): Promise<AgentCreationDraft[]> {
    const table = pgSchema.agentCreationDraftsPostgres;
    const rows = await this.db
      .select()
      .from(table)
      .where(eq(table.appId, appId))
      .orderBy(desc(table.updatedAt), desc(table.id));
    return rows.map(toDraft);
  }

  async getDraft(input: {
    appId: AgentCreationDraft['appId'];
    id: AgentCreationDraft['id'];
  }): Promise<AgentCreationDraft | null> {
    const table = pgSchema.agentCreationDraftsPostgres;
    const [row] = await this.db
      .select()
      .from(table)
      .where(and(eq(table.appId, input.appId), eq(table.id, input.id)))
      .limit(1);
    return row ? toDraft(row) : null;
  }

  async saveDraft(input: {
    draft: AgentCreationDraft;
    expectedRevision?: number;
  }): Promise<AgentCreationDraft | 'conflict'> {
    const table = pgSchema.agentCreationDraftsPostgres;
    const draft = input.draft;
    if (input.expectedRevision === undefined) {
      const [row] = await this.db
        .insert(table)
        .values({
          id: draft.id,
          appId: draft.appId,
          revision: 1,
          createdAt: draft.createdAt,
          ...valuesFor(draft),
        })
        .onConflictDoNothing({ target: table.id })
        .returning();
      return row ? toDraft(row) : 'conflict';
    }

    const [row] = await this.db
      .update(table)
      .set({
        revision: input.expectedRevision + 1,
        ...valuesFor(draft),
      })
      .where(
        and(
          eq(table.appId, draft.appId),
          eq(table.id, draft.id),
          eq(table.revision, input.expectedRevision),
        ),
      )
      .returning();
    return row ? toDraft(row) : 'conflict';
  }

  async deleteDraft(input: {
    appId: AgentCreationDraft['appId'];
    id: AgentCreationDraft['id'];
  }): Promise<'deleted' | 'not_found' | 'agent_exists'> {
    const table = pgSchema.agentCreationDraftsPostgres;
    const deleted = await this.db
      .delete(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.id, input.id),
          isNull(table.agentId),
        ),
      )
      .returning({ id: table.id });
    if (deleted.length > 0) return 'deleted';
    return (await this.getDraft(input)) ? 'agent_exists' : 'not_found';
  }

  async claimDraft(input: {
    appId: AgentCreationDraft['appId'];
    id: AgentCreationDraft['id'];
    leaseToken: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<AgentCreationDraft | null> {
    const table = pgSchema.agentCreationDraftsPostgres;
    const [row] = await this.db
      .update(table)
      .set({
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
        status: 'applying',
        updatedAt: input.now,
      })
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.id, input.id),
          or(
            isNull(table.leaseExpiresAt),
            lte(table.leaseExpiresAt, input.now),
            eq(table.leaseToken, input.leaseToken),
          ),
        ),
      )
      .returning();
    return row ? toDraft(row) : null;
  }

  async deleteCompletedBefore(input: {
    before: string;
    limit: number;
  }): Promise<number> {
    if (input.limit < 1) return 0;
    const table = pgSchema.agentCreationDraftsPostgres;
    const rows = await this.db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.status, 'completed'),
          lte(table.completedAt, input.before),
        ),
      )
      .orderBy(table.completedAt)
      .limit(input.limit);
    if (rows.length === 0) return 0;
    const deleted = await this.db
      .delete(table)
      .where(
        and(
          inArray(
            table.id,
            rows.map((row) => row.id),
          ),
          eq(table.status, 'completed'),
          lte(table.completedAt, input.before),
        ),
      )
      .returning({ id: table.id });
    return deleted.length;
  }
}

import { and, desc, eq } from 'drizzle-orm';

import type {
  AppendSettingsRevisionResult,
  SettingsRevision,
  SettingsRevisionRepository,
} from '../../../../domain/ports/fleet-capability-state.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { isUniqueViolation } from './worker-coordination-lease.postgres.js';

type SettingsRevisionRow =
  typeof pgSchema.settingsRevisionsPostgres.$inferSelect;

const MAX_APPEND_ATTEMPTS = 5;

function toSettingsRevision(row: SettingsRevisionRow): SettingsRevision {
  return {
    appId: row.appId,
    revision: row.revision,
    settingsDocument: (row.settingsDocumentJson ?? {}) as Record<
      string,
      unknown
    >,
    minReaderVersion: row.minReaderVersion,
    createdBy: row.createdBy,
    note: row.note ?? null,
    createdAt: row.createdAt,
  };
}

export class PostgresSettingsRevisionRepository implements SettingsRevisionRepository {
  constructor(private readonly db: CanonicalDb) {}

  async appendSettingsRevision(input: {
    appId: string;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note?: string | null;
    expectedRevision?: number | null;
    now?: string;
  }): Promise<AppendSettingsRevisionResult> {
    const now = input.now ?? nowIso();
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== null
    ) {
      return this.appendAtExpectedRevision({
        ...input,
        expectedRevision: input.expectedRevision,
        now,
      });
    }
    const table = pgSchema.settingsRevisionsPostgres;
    // Unconditional append: allocate the next revision against the current max
    // and let the (app_id, revision) unique key serialize concurrent appends. A
    // losing append retries against the new max rather than overwriting.
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const latest = await this.getLatestSettingsRevision(input.appId);
      const revision = (latest?.revision ?? 0) + 1;
      const row: SettingsRevisionRow = {
        appId: input.appId,
        revision,
        settingsDocumentJson: input.settingsDocument,
        minReaderVersion: input.minReaderVersion,
        createdBy: input.createdBy,
        note: input.note ?? null,
        createdAt: now,
      };
      try {
        await this.db.insert(table).values(row);
        return { status: 'appended', revision: toSettingsRevision(row) };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new Error(
      `Failed to allocate a settings revision for ${input.appId} after ${MAX_APPEND_ATTEMPTS} attempts`,
    );
  }

  /**
   * Conditional append (optimistic concurrency): insert exactly
   * `expectedRevision + 1` with NO retry past a conflict. The stale-head check
   * catches an outdated expectation up front; the (app_id, revision) unique key
   * then atomically arbitrates the race two same-expectation writers can still
   * reach — exactly one insert wins, the loser maps the unique violation to a
   * conflict instead of silently appending the next revision (lost update).
   */
  private async appendAtExpectedRevision(input: {
    appId: string;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note?: string | null;
    expectedRevision: number;
    now: string;
  }): Promise<AppendSettingsRevisionResult> {
    const latest = await this.getLatestSettingsRevision(input.appId);
    const currentRevision = latest?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      return {
        status: 'conflict',
        expectedRevision: input.expectedRevision,
        actualRevision: currentRevision,
      };
    }
    const row: SettingsRevisionRow = {
      appId: input.appId,
      revision: input.expectedRevision + 1,
      settingsDocumentJson: input.settingsDocument,
      minReaderVersion: input.minReaderVersion,
      createdBy: input.createdBy,
      note: input.note ?? null,
      createdAt: input.now,
    };
    try {
      await this.db.insert(pgSchema.settingsRevisionsPostgres).values(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const head = await this.getLatestSettingsRevision(input.appId);
      return {
        status: 'conflict',
        expectedRevision: input.expectedRevision,
        actualRevision: head?.revision ?? input.expectedRevision + 1,
      };
    }
    return { status: 'appended', revision: toSettingsRevision(row) };
  }

  async getLatestSettingsRevision(
    appId: string,
  ): Promise<SettingsRevision | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.settingsRevisionsPostgres)
      .where(eq(pgSchema.settingsRevisionsPostgres.appId, appId))
      .orderBy(desc(pgSchema.settingsRevisionsPostgres.revision))
      .limit(1);
    return rows[0] ? toSettingsRevision(rows[0]) : null;
  }

  async getSettingsRevision(input: {
    appId: string;
    revision: number;
  }): Promise<SettingsRevision | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.settingsRevisionsPostgres)
      .where(
        and(
          eq(pgSchema.settingsRevisionsPostgres.appId, input.appId),
          eq(pgSchema.settingsRevisionsPostgres.revision, input.revision),
        ),
      )
      .limit(1);
    return rows[0] ? toSettingsRevision(rows[0]) : null;
  }

  async listRecentSettingsRevisions(input: {
    appId: string;
    limit: number;
  }): Promise<SettingsRevision[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.settingsRevisionsPostgres)
      .where(eq(pgSchema.settingsRevisionsPostgres.appId, input.appId))
      .orderBy(desc(pgSchema.settingsRevisionsPostgres.revision))
      .limit(Math.max(1, Math.floor(input.limit)));
    return rows.map(toSettingsRevision);
  }
}

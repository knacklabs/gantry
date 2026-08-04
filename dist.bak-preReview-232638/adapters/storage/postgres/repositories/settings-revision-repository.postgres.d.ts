import type { AppendSettingsRevisionResult, SettingsRevision, SettingsRevisionRepository } from '../../../../domain/ports/fleet-capability-state.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresSettingsRevisionRepository implements SettingsRevisionRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    appendSettingsRevision(input: {
        appId: string;
        settingsDocument: Record<string, unknown>;
        minReaderVersion: number;
        createdBy: string;
        note?: string | null;
        expectedRevision?: number | null;
        now?: string;
    }): Promise<AppendSettingsRevisionResult>;
    /**
     * Conditional append (optimistic concurrency): insert exactly
     * `expectedRevision + 1` with NO retry past a conflict. The stale-head check
     * catches an outdated expectation up front; the (app_id, revision) unique key
     * then atomically arbitrates the race two same-expectation writers can still
     * reach — exactly one insert wins, the loser maps the unique violation to a
     * conflict instead of silently appending the next revision (lost update).
     */
    private appendAtExpectedRevision;
    getLatestSettingsRevision(appId: string): Promise<SettingsRevision | null>;
    getSettingsRevision(input: {
        appId: string;
        revision: number;
    }): Promise<SettingsRevision | null>;
    listRecentSettingsRevisions(input: {
        appId: string;
        limit: number;
    }): Promise<SettingsRevision[]>;
}

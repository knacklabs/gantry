import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { ObserverSubjectKey } from '../domain/ports/observer-insights.js';
import type { PatternCandidateSubject } from '../domain/ports/pattern-candidates.js';
import { type PatternCandidateDraft, type PatternTranscriptTurn } from '../shared/pattern-candidate-detection.js';
import { type CanonicalMemoryItemRow } from './app-memory-canonical-codec.js';
import type { BlockedDreamDecision, DemoteDreamingMemoryInput, DeleteAppMemoryInput, DreamingRunStatus, MemoryBoundaryContext, MemorySubjectType, NormalizedMemorySubject } from './memory-types.js';
type Db = NodePgDatabase<typeof pgSchema>;
export declare function listObserverActiveMemoryValues(input: {
    db: Db;
    appId: string;
    subject: ObserverSubjectKey;
}): Promise<string[]>;
export declare function findActiveMemoryByKey(input: {
    db: Db;
    subject: NormalizedMemorySubject;
    key: string;
}): Promise<CanonicalMemoryItemRow | null>;
export declare function listDreamingStatuses(db: Db, input?: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
}, options?: {
    signal?: AbortSignal;
    statementTimeoutMs?: number;
}): Promise<DreamingRunStatus[]>;
export declare function listRecentBlockedDreamDecisions(db: Db, input?: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
}, options?: {
    signal?: AbortSignal;
    statementTimeoutMs?: number;
    limit?: number;
}): Promise<BlockedDreamDecision[]>;
export declare function getOwnedMemoryItem(input: {
    db: Db;
    context: NormalizedMemorySubject;
    id: string;
}): Promise<CanonicalMemoryItemRow | null>;
export declare function deleteOwnedMemoryItem(input: {
    db: Db;
    context: NormalizedMemorySubject;
    id: string;
    expectedVersion?: DeleteAppMemoryInput['expectedVersion'];
    isAdminWrite?: DeleteAppMemoryInput['isAdminWrite'];
}): Promise<{
    deleted: boolean;
}>;
export declare function demoteDreamingPromotedMemoryItem(input: {
    db: Db;
    context: NormalizedMemorySubject;
    id: string;
    expectedVersion?: DemoteDreamingMemoryInput['expectedVersion'];
    isAdminWrite?: DemoteDreamingMemoryInput['isAdminWrite'];
    actorId?: DemoteDreamingMemoryInput['actorId'];
    reason?: DemoteDreamingMemoryInput['reason'];
}): Promise<{
    demoted: boolean;
}>;
export type OwnedMemoryItemLookupInput = {
    id: string;
} & Partial<MemoryBoundaryContext>;
declare const patternCandidatesTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "pattern_candidates";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        appId: import("drizzle-orm/pg-core").PgColumn<{
            name: "app_id";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        agentId: import("drizzle-orm/pg-core").PgColumn<{
            name: "agent_id";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        folder: import("drizzle-orm/pg-core").PgColumn<{
            name: "folder";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        subjectType: import("drizzle-orm/pg-core").PgColumn<{
            name: "subject_type";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        subjectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "subject_id";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        signature: import("drizzle-orm/pg-core").PgColumn<{
            name: "signature";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        outcomeLabel: import("drizzle-orm/pg-core").PgColumn<{
            name: "outcome_label";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        shortAsk: import("drizzle-orm/pg-core").PgColumn<{
            name: "short_ask";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        occurrences: import("drizzle-orm/pg-core").PgColumn<{
            name: "occurrences";
            tableName: "pattern_candidates";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        windowStart: import("drizzle-orm/pg-core").PgColumn<{
            name: "window_start";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        windowEnd: import("drizzle-orm/pg-core").PgColumn<{
            name: "window_end";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastDetectedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_detected_at";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        candidateStatus: import("drizzle-orm/pg-core").PgColumn<{
            name: "candidate_status";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        proposalStatus: import("drizzle-orm/pg-core").PgColumn<{
            name: "proposal_status";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        snoozedUntil: import("drizzle-orm/pg-core").PgColumn<{
            name: "snoozed_until";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        evidenceRefsJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "evidence_refs";
            tableName: "pattern_candidates";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "pattern_candidates";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
/**
 * The pattern-candidate detection pass, run inside the dreaming deep phase.
 * Detects repeated work (pure heuristic) and upserts candidates by signature.
 * It only writes `detected` candidates — it never creates, edits, or proposes a
 * skill. Returns the number of candidates upserted.
 */
export declare function detectAndUpsertPatternCandidates(input: {
    db: Db;
    subject: PatternCandidateSubject;
    transcriptTurns: PatternTranscriptTurn[];
    windowStart: string;
    windowEnd: string;
    nowIso: string;
}): Promise<number>;
/**
 * Pure row builder for a newly detected candidate. The id is derived from the
 * unique key so a re-detection maps to the same row (idempotent). Always
 * `detected` with no proposal — the batch path can never start a proposal (the
 * invariant). Exported for testing.
 */
export declare function buildDetectedRowValues(subject: PatternCandidateSubject, draft: PatternCandidateDraft, window: {
    windowStart: string;
    windowEnd: string;
    nowIso: string;
}): typeof patternCandidatesTable.$inferInsert;
export {};

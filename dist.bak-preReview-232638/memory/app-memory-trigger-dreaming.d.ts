import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { AppMemoryItem, DeleteAppMemoryInput, DreamingRunStatus, DreamingTriggerInput, SaveAppMemoryInput } from './memory-types.js';
type Db = NodePgDatabase<typeof pgSchema>;
type MemoryEvidenceRow = typeof pgSchema.memoryEvidencePostgres.$inferSelect;
export declare function patternTranscriptTurnsFromEvidence(evidence: MemoryEvidenceRow[]): {
    intent: string;
    messageId: string;
}[];
export declare function triggerAppMemoryDreaming(input: {
    db: Db;
    triggerInput?: DreamingTriggerInput;
    save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
    retire: (value: DeleteAppMemoryInput) => Promise<{
        deleted: boolean;
    }>;
}): Promise<DreamingRunStatus>;
export {};

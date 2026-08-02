import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { BrainDreamCursor, BrainDreamDecisionWrite } from '../../../../brain/brain-repository.js';
import type { BrainPage } from '../../../../brain/brain-types.js';
import * as pgSchema from '../schema/schema.js';
type Db = NodePgDatabase<typeof pgSchema>;
export declare function getBrainDreamCursor(db: Db, appId: string): Promise<BrainDreamCursor | null>;
export declare function listBrainPagesForDream(db: Db, input: {
    appId: string;
    cursor?: BrainDreamCursor | null;
    limit: number;
}): Promise<BrainPage[]>;
export declare function saveBrainDreamCursor(db: Db, appId: string, cursor: BrainDreamCursor): Promise<void>;
export declare function journalBrainDreamDecision(db: Db, input: BrainDreamDecisionWrite): Promise<void>;
export {};

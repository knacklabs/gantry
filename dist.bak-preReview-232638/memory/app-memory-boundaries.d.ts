import { type SQL } from 'drizzle-orm';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { MemoryBoundaryContext, MemorySubjectType, NormalizedMemorySubject } from './memory-types.js';
export declare const DEFAULT_MEMORY_APP_ID = "default";
export declare function memoryAgentIdForWorkspaceFolder(workspaceFolder: string): string;
export declare function subjectIdFor(subject: NormalizedMemorySubject): string;
export declare function normalizeSubject(input: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
    visibility?: MemorySubjectType;
}): NormalizedMemorySubject;
export declare function visibleSubjectFilters(i: typeof pgSchema.memoryItemsPostgres, input: Partial<MemoryBoundaryContext> & {
    includeCommon?: boolean;
    subjectTypes?: MemorySubjectType[];
}): SQL[];

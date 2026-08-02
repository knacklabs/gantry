import type { AppMemoryItem, MemoryKind, NormalizedMemorySubject } from './memory-types.js';
export interface CanonicalMemoryItemRow {
    id: string;
    appId: string;
    agentId: string | null;
    subjectType: string;
    subjectId: string;
    userId: string | null;
    conversationId: string | null;
    threadId: string | null;
    kind: string;
    key: string;
    valueJson: unknown;
    sourceRefJson: unknown;
    confidence: number;
    status: string;
    lastObservedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export declare function hashText(value: string): string;
export declare function parseJsonObject(value: unknown): Record<string, unknown>;
export declare function parseItemValue(row: CanonicalMemoryItemRow): {
    value: string;
    why: string | null;
};
export declare function parseItemSource(row: CanonicalMemoryItemRow): {
    subject: NormalizedMemorySubject;
    source: string;
    evidenceIds: string[];
    isPinned: boolean;
    version: number;
    retrievalCount?: number;
    totalScore?: number;
    maxScore?: number;
};
export declare function encodeItemSource(input: {
    subject: NormalizedMemorySubject;
    source: string;
    evidenceIds: string[];
    isPinned: boolean;
    version: number;
    retrievalCount?: number;
    totalScore?: number;
    maxScore?: number;
}): Record<string, unknown>;
export declare function clampConfidence(value: number | undefined, fallback?: number): number;
export declare function normalizeKind(value: string | undefined): MemoryKind;
export declare function toAppItem(row: CanonicalMemoryItemRow): AppMemoryItem;
export declare function itemMatchesSubjectBoundary(row: CanonicalMemoryItemRow, context: NormalizedMemorySubject): boolean;

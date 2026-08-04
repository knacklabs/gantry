import { parseItemSource } from './app-memory-canonical-codec.js';
import type { NormalizedMemorySubject, SaveAppMemoryInput } from './memory-types.js';
export declare function memoryContentHash(input: {
    appId: string;
    agentId: string;
    subjectType: string;
    subjectId: string;
    key: string;
    value: string;
}): string;
/**
 * Canonical text that is embedded for a memory item. The content hash is taken
 * over exactly this string so that any change to key/value/why re-embeds the
 * item (and only that item). Dreaming and backfill share this so a single ready
 * vector represents the item's current text.
 */
export declare function embeddingTextForMemory(input: {
    key: string;
    value: string;
    why?: string | null;
}): string;
export declare function embeddingContentHash(input: {
    key: string;
    value: string;
    why?: string | null;
}): string;
export declare function isUniqueViolation(err: unknown): boolean;
type ParsedItemSource = ReturnType<typeof parseItemSource>;
export declare function buildMemoryItemWriteBase(input: {
    subject: NormalizedMemorySubject;
    saveInput: SaveAppMemoryInput;
    key: string;
    value: string;
    evidenceIds: string[];
    existingSource: ParsedItemSource | null;
    timestamp: string;
}): {
    appId: string;
    agentId: string;
    subjectType: import("./memory-types.js").MemorySubjectType;
    subjectId: string;
    userId: string | null;
    conversationId: string | null;
    threadId: null;
    kind: import("./memory-types.js").MemoryKind;
    key: string;
    valueJson: {
        value: string;
        why: string | null;
        contentHash: string;
    };
    sourceRefJson: Record<string, unknown>;
    confidence: number;
    status: "active";
    lastObservedAt: string;
    updatedAt: string;
};
export {};

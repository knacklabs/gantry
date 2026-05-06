import type {
  MemoryChunk,
  MemoryItem,
  MemoryProcedure,
  MemoryScope,
  MemorySearchResult,
  SimilarMemoryItemMatch,
} from './domain-types.js';

export interface ChunkInsert {
  source_type: string;
  source_id: string;
  source_path: string;
  scope: MemoryScope;
  group_folder: string;
  topic_id?: string | null;
  kind: string;
  text: string;
  importance_weight?: number;
  embedding: number[] | null;
}

export interface RetentionPolicyResult {
  removedItemIds: string[];
  removedProcedureIds: string[];
  evictedChunkIds: string[];
}

export interface MemoryRepository {
  close(): void | Promise<void>;
  runHealthChecks(): void | Promise<void>;
  saveItem(
    input: Partial<MemoryItem> &
      Pick<
        MemoryItem,
        | 'scope'
        | 'group_folder'
        | 'kind'
        | 'key'
        | 'value'
        | 'source'
        | 'confidence'
      >,
  ): Promise<MemoryItem>;
  findItemByKey(input: {
    scope: MemoryScope;
    agentFolder: string;
    key: string;
    userId?: string | null;
    topicId?: string | null;
  }): Promise<MemoryItem | null>;
  getItemById(id: string): Promise<MemoryItem | null>;
  getItemByIdAny(id: string): Promise<MemoryItem | null>;
  getItemByFilePath(filePath: string): Promise<MemoryItem | null>;
  getItemByFilePathAny(filePath: string): Promise<MemoryItem | null>;
  listIndexedFiles(): Promise<
    Array<{
      id: string;
      file_path: string;
      content_hash: string;
      indexed_at: string | null;
      source_folder: string;
    }>
  >;
  listIndexedChunkFiles(): Promise<
    Array<{
      source_type: string;
      source_id: string;
      source_path: string;
      indexed_at: string | null;
    }>
  >;
  patchItem(
    id: string,
    expectedVersion: number,
    patch: Partial<MemoryItem>,
  ): Promise<MemoryItem>;
  pinItem(id: string, pinned?: boolean): Promise<void>;
  saveItemEmbedding(itemId: string, embedding: number[]): Promise<void>;
  markItemEmbeddingPending(
    itemId: string,
    pending: boolean,
    blockedReason?: string | null,
  ): Promise<void>;
  setItemFileMetadata(input: {
    id: string;
    sourceFolder: string;
    filePath: string;
    contentHash: string;
    indexedAt?: string;
  }): Promise<void>;
  getCachedEmbedding(textHash: string, model: string): Promise<number[] | null>;
  putCachedEmbedding(
    textHash: string,
    model: string,
    embedding: number[],
  ): Promise<void>;
  findSimilarItems(input: {
    embedding: number[];
    agentFolder: string;
    limit?: number;
    threshold?: number;
  }): Promise<SimilarMemoryItemMatch[]>;
  listActiveItems(agentFolder: string, limit?: number): Promise<MemoryItem[]>;
  softDeleteItem(id: string, supersededBy?: string | null): Promise<void>;
  incrementRetrievalCount(ids: string[]): Promise<void>;
  recordRetrievalSignal(
    itemId: string,
    signal: { queryHash?: string; score?: number; recallDay?: string },
  ): Promise<void>;
  bumpConfidence(ids: string[], delta: number): Promise<void>;
  adjustConfidence(ids: string[], delta: number): Promise<void>;
  decayUnusedConfidence(agentFolder: string, delta: number): Promise<number>;
  countReflectionsSinceLastUsageDecay(agentFolder: string): Promise<number>;
  recordUsageDecayRun(agentFolder: string): Promise<void>;
  listTopItems(agentFolder: string, limit?: number): Promise<MemoryItem[]>;
  chunkExists(input: ChunkInsert): Promise<boolean>;
  touchItem(id: string): Promise<void>;
  saveProcedure(
    input: Partial<MemoryProcedure> &
      Pick<
        MemoryProcedure,
        'scope' | 'group_folder' | 'title' | 'body' | 'source' | 'confidence'
      >,
  ): Promise<MemoryProcedure>;
  getProcedureById(id: string): Promise<MemoryProcedure | null>;
  getProcedureByIdAny(id: string): Promise<MemoryProcedure | null>;
  patchProcedure(
    id: string,
    expectedVersion: number,
    patch: Partial<MemoryProcedure>,
  ): Promise<MemoryProcedure>;
  listTopProcedures(
    agentFolder: string,
    limit?: number,
  ): Promise<MemoryProcedure[]>;
  softDeleteProcedure(id: string): Promise<void>;
  saveChunks(chunks: ChunkInsert[]): Promise<number>;
  lexicalSearch(
    query: string,
    agentFolder: string,
    limit?: number,
  ): Promise<MemorySearchResult[]>;
  vectorSearch(
    embedding: number[],
    agentFolder: string,
    limit?: number,
  ): Promise<MemorySearchResult[]>;
  searchProceduresByText(
    query: string,
    agentFolder: string,
    limit?: number,
  ): Promise<MemoryProcedure[]>;
  listSourceChunks(
    sourceType: string,
    sourceId: string,
  ): Promise<MemoryChunk[]>;
  deleteSourceChunks(sourceType: string, sourceId: string): Promise<number>;
  applyRetentionPolicies(agentFolder: string): Promise<RetentionPolicyResult>;
  recordEvent(
    eventType: string,
    entityType: string,
    entityId: string | null,
    payload: unknown,
  ): Promise<void>;
  getLatestEvent(
    eventType: string,
    entityType: string,
    entityId?: string | null,
  ): Promise<{ payload: unknown; created_at: string } | null>;
}

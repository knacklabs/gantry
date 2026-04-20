import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  MEMORY_ROOT,
  MEMORY_CHUNK_OVERLAP,
  MEMORY_CHUNK_SIZE,
  MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD,
  MEMORY_CONSOLIDATION_MAX_CLUSTERS,
  MEMORY_CONSOLIDATION_MIN_ITEMS,
  MEMORY_DREAMING_CONFIDENCE_BOOST,
  MEMORY_DREAMING_CONFIDENCE_DECAY,
  MEMORY_DREAMING_DECAY_THRESHOLD,
  MEMORY_DREAMING_MIN_RECALLS,
  MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
  MEMORY_DREAMING_PROMOTION_THRESHOLD,
  MEMORY_EXTRACTOR_MIN_CONFIDENCE,
  MEMORY_EXTRACTOR_MAX_TURNS,
  MEMORY_GLOBAL_KNOWLEDGE_DIR,
  MEMORY_MMR_LAMBDA,
  MEMORY_RETRIEVAL_MIN_SCORE,
  MEMORY_RETENTION_PIN_THRESHOLD,
  MEMORY_RRF_LEXICAL_WEIGHT,
  MEMORY_RRF_VECTOR_WEIGHT,
  MEMORY_RETRIEVAL_LIMIT,
  MEMORY_JOURNAL_DISABLED,
  RUNTIME_MEMORY_ENABLED,
  MEMORY_SEMANTIC_DEDUP_ENABLED,
  MEMORY_SEMANTIC_DEDUP_THRESHOLD,
  MEMORY_SOURCE_TYPE_BOOSTS,
  MEMORY_SCOPE_POLICY,
  MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS,
  RUNTIME_MEMORY_DREAMING_ENABLED,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  createEmbeddingProvider,
  EmbeddingProvider,
} from './memory-embeddings.js';
import { CachedEmbeddingProvider } from './memory-embedding-cache.js';
import {
  consolidateMemoryItems,
  ConsolidationResult,
} from './memory-consolidation.js';
import {
  DreamingResult,
  runDreamingSweep as runMemoryDreamingSweep,
} from './memory-dreaming.js';
import {
  createMemoryExtractionProvider,
  MemoryExtractorUsage,
  MemoryExtractionProvider,
} from './memory-extractor.js';
import { ChunkInsert, MemoryStore } from './memory-store.js';
import { JournalAppendInput, MemoryJournal } from './memory-journal.js';
import { MemoryIndexer } from './memory-indexer.js';
import { fuseSearchResults } from './memory-retrieval.js';
import { classifySensitiveMemoryMaterial } from './sensitive-material.js';
import {
  MEMORY_GLOBAL_GROUP_FOLDER,
  MemoryItem,
  MemoryProcedure,
  MemoryScope,
  MemorySearchResult,
  MemoryWriteContext,
  PatchMemoryInput,
  PatchProcedureInput,
  SaveMemoryInput,
  SaveProcedureInput,
} from './memory-types.js';

interface SearchInput {
  query: string;
  groupFolder: string;
  userId?: string;
  limit?: number;
  source?: string;
}

interface TranscriptExtractionInput {
  groupFolder: string;
  transcriptPath: string;
  trigger: 'precompact' | 'session-end';
  sessionId?: string;
  userId?: string;
}

interface BuildBriefInput {
  groupFolder: string;
  maxItems: number;
  userId?: string;
}

interface ArcTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface MemoryStatusSnapshot {
  items_by_kind: Record<string, number>;
  items_by_scope: Record<string, number>;
  top10_most_used: Array<{ key: string; retrieval_count: number }>;
  top10_stalest: Array<{ key: string; updated_at: string }>;
  last_dream_run?: { at?: string; summary?: string };
  disk_kb?: Record<string, number>;
}

interface SourceDoc {
  sourceId: string;
  sourcePath: string;
  sourceType: string;
  text: string;
}

export interface MemoryServiceCounters {
  extractions_total: number;
  extractions_failed_total: number;
  facts_saved_total: number;
  facts_filtered_sensitive_total: number;
  journal_writes_failed_total: number;
  stale_patch_retries_total: number;
  dreaming_sweeps_total: number;
  cache_read_tokens_total: number;
  cache_creation_tokens_total: number;
}

const INITIAL_MEMORY_COUNTERS: MemoryServiceCounters = {
  extractions_total: 0,
  extractions_failed_total: 0,
  facts_saved_total: 0,
  facts_filtered_sensitive_total: 0,
  journal_writes_failed_total: 0,
  stale_patch_retries_total: 0,
  dreaming_sweeps_total: 0,
  cache_read_tokens_total: 0,
  cache_creation_tokens_total: 0,
};

let memoryServiceSingleton: MemoryService | null = null;

export class MemoryService {
  private static counters: MemoryServiceCounters = {
    ...INITIAL_MEMORY_COUNTERS,
  };
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingProvider;
  private readonly extractor: MemoryExtractionProvider;
  private readonly journal: MemoryJournal;
  private readonly indexer: MemoryIndexer;

  private static incrementCounter(
    name: keyof MemoryServiceCounters,
    delta = 1,
  ): void {
    const next = (MemoryService.counters[name] || 0) + delta;
    MemoryService.counters[name] = Math.max(0, Number(next) || 0);
  }

  static getCountersSnapshot(): MemoryServiceCounters {
    return { ...MemoryService.counters };
  }

  constructor(
    store: MemoryStore = new MemoryStore(),
    embeddings: EmbeddingProvider = createEmbeddingProvider(),
    extractor: MemoryExtractionProvider = createMemoryExtractionProvider(),
    journal: MemoryJournal = new MemoryJournal(
      path.join(MEMORY_ROOT, '.journal'),
      MEMORY_JOURNAL_DISABLED,
    ),
  ) {
    this.store = store;
    this.embeddings = new CachedEmbeddingProvider(embeddings, this.store);
    this.extractor = extractor;
    this.journal = journal;
    this.indexer = new MemoryIndexer(MEMORY_ROOT, this.store, this.embeddings);
    this.embeddings.validateConfiguration();
  }

  static getInstance(): MemoryService {
    if (!memoryServiceSingleton) {
      memoryServiceSingleton = new MemoryService();
    }
    return memoryServiceSingleton;
  }

  static closeInstance(): void {
    memoryServiceSingleton?.journal.close();
    memoryServiceSingleton?.store.close();
    memoryServiceSingleton = null;
  }

  getProviderName(): string {
    return RUNTIME_MEMORY_ENABLED ? 'sqlite' : 'disabled';
  }

  getCounters(): MemoryServiceCounters {
    return MemoryService.getCountersSnapshot();
  }

  async reindexFiles(): Promise<{ scanned: number; reindexed: number }> {
    return await this.indexer.reindexStaleFilesAndWait();
  }

  async consolidateGroupMemory(
    groupFolder: string,
  ): Promise<ConsolidationResult> {
    return consolidateMemoryItems({
      groupFolder,
      store: this.store,
      embeddings: this.embeddings,
      minItems: MEMORY_CONSOLIDATION_MIN_ITEMS,
      clusterThreshold: MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD,
      maxClusters: MEMORY_CONSOLIDATION_MAX_CLUSTERS,
    });
  }

  async runDreamingSweep(groupFolder: string): Promise<DreamingResult> {
    MemoryService.incrementCounter('dreaming_sweeps_total');
    return runMemoryDreamingSweep({
      groupFolder,
      store: this.store,
      consolidateGroupMemory: (targetGroupFolder) =>
        this.consolidateGroupMemory(targetGroupFolder),
      retentionPinThreshold: MEMORY_RETENTION_PIN_THRESHOLD,
      promotionThreshold: MEMORY_DREAMING_PROMOTION_THRESHOLD,
      decayThreshold: MEMORY_DREAMING_DECAY_THRESHOLD,
      minRecalls: MEMORY_DREAMING_MIN_RECALLS,
      minUniqueQueries: MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
      confidenceBoost: MEMORY_DREAMING_CONFIDENCE_BOOST,
      confidenceDecay: MEMORY_DREAMING_CONFIDENCE_DECAY,
      enabled: RUNTIME_MEMORY_DREAMING_ENABLED,
    });
  }

  async getStatus(groupFolder: string): Promise<MemoryStatusSnapshot> {
    if (!RUNTIME_MEMORY_ENABLED) {
      return {
        items_by_kind: {},
        items_by_scope: {},
        top10_most_used: [],
        top10_stalest: [],
      };
    }
    const groupItems = this.store.listActiveItems(groupFolder, 20_000);
    const globalItems = this.store.listTopItems('global', groupFolder, 5_000);
    const items = dedupeItemsById([...groupItems, ...globalItems]);

    const itemsByKind: Record<string, number> = {};
    const itemsByScope: Record<string, number> = {};
    for (const item of items) {
      itemsByKind[item.kind] = (itemsByKind[item.kind] || 0) + 1;
      itemsByScope[item.scope] = (itemsByScope[item.scope] || 0) + 1;
    }

    const topUsed = [...items]
      .sort((a, b) => b.retrieval_count - a.retrieval_count)
      .slice(0, 10)
      .map((item) => ({
        key: item.key,
        retrieval_count: item.retrieval_count,
      }));
    const topStalest = [...items]
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
      .slice(0, 10)
      .map((item) => ({ key: item.key, updated_at: item.updated_at }));

    const latestDream =
      this.store.getLatestEvent('dream_completed', groupFolder) ||
      this.store.getLatestEvent('dreaming_completed', groupFolder);
    let lastDreamRun: MemoryStatusSnapshot['last_dream_run'] = undefined;
    if (latestDream) {
      let summary = '';
      try {
        const payload = JSON.parse(latestDream.payload_json) as {
          promotedCount?: number;
          retiredCount?: number;
          decayedCount?: number;
        };
        summary = `promoted=${payload.promotedCount ?? 0}, decayed=${payload.decayedCount ?? 0}, retired=${payload.retiredCount ?? 0}`;
      } catch {
        summary = '';
      }
      lastDreamRun = {
        at: latestDream.created_at,
        ...(summary ? { summary } : {}),
      };
    }

    let diskKb: Record<string, number> | undefined;
    try {
      const layout = {
        itemsDir: path.join(MEMORY_ROOT, 'items'),
        proceduresDir: path.join(MEMORY_ROOT, 'procedures'),
        sessionsDir: path.join(MEMORY_ROOT, 'sessions'),
        journalDir: path.join(MEMORY_ROOT, '.journal'),
      };
      diskKb = {
        items: directorySizeKb(layout.itemsDir),
        procedures: directorySizeKb(layout.proceduresDir),
        sessions: directorySizeKb(layout.sessionsDir),
        journal: directorySizeKb(layout.journalDir),
      };
    } catch {
      diskKb = undefined;
    }

    return {
      items_by_kind: itemsByKind,
      items_by_scope: itemsByScope,
      top10_most_used: topUsed,
      top10_stalest: topStalest,
      ...(lastDreamRun ? { last_dream_run: lastDreamRun } : {}),
      ...(diskKb ? { disk_kb: diskKb } : {}),
    };
  }

  async ingestGroupSources(groupFolder: string): Promise<void> {
    const files: SourceDoc[] = [];
    const groupDir = path.join(AGENTS_DIR, groupFolder);

    const claudePath = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      files.push({
        sourceId: `claude:${groupFolder}`,
        sourcePath: claudePath,
        sourceType: 'claude_md',
        text: fs.readFileSync(claudePath, 'utf-8'),
      });
    }
    files.push(
      ...this.collectMarkdownDocs(
        path.join(groupDir, 'knowledge'),
        (filePath, relPath) => ({
          sourceId: `local_doc:${groupFolder}:${relPath}`,
          sourcePath: filePath,
          sourceType: 'local_doc',
          text: fs.readFileSync(filePath, 'utf-8'),
        }),
      ),
    );

    await this.ingestDocuments(files, 'group', groupFolder);

    this.applyRetentionWithJournal(groupFolder, 'retention:ingest');
  }

  async ingestGlobalKnowledge(dirOverride?: string): Promise<void> {
    const knowledgeDir = dirOverride || MEMORY_GLOBAL_KNOWLEDGE_DIR;
    if (!knowledgeDir) return;
    if (!fs.existsSync(knowledgeDir)) return;

    const docs = this.collectMarkdownDocs(
      knowledgeDir,
      (filePath, relPath) => ({
        sourceId: `knowledge_doc:${relPath}`,
        sourcePath: filePath,
        sourceType: 'knowledge_doc',
        text: fs.readFileSync(filePath, 'utf-8'),
      }),
    );
    if (docs.length === 0) return;

    await this.ingestDocuments(docs, 'global', MEMORY_GLOBAL_GROUP_FOLDER);
    this.applyRetentionWithJournal(
      MEMORY_GLOBAL_GROUP_FOLDER,
      'retention:global',
    );
  }

  private collectMarkdownDocs(
    rootDir: string,
    toSourceDoc: (filePath: string, relPath: string) => SourceDoc,
  ): SourceDoc[] {
    if (!fs.existsSync(rootDir)) return [];

    const docs: SourceDoc[] = [];
    const stack: string[] = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const nextPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(nextPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
          continue;
        }
        const relPath = path.relative(rootDir, nextPath).replace(/\\/g, '/');
        docs.push(toSourceDoc(nextPath, relPath));
      }
    }

    return docs;
  }

  private async ingestDocuments(
    files: SourceDoc[],
    scope: MemoryScope,
    groupFolder: string,
  ): Promise<void> {
    for (const file of files) {
      const baseImportance = Math.max(
        0,
        MEMORY_SOURCE_TYPE_BOOSTS[file.sourceType] ?? 1,
      );
      const chunks: ChunkInsert[] = chunkText(
        file.text,
        MEMORY_CHUNK_SIZE,
        MEMORY_CHUNK_OVERLAP,
      )
        .map((text) => text.trim())
        .filter((text) => text.length > 30)
        .map((text) => ({
          source_type: file.sourceType,
          source_id: file.sourceId,
          source_path: file.sourcePath,
          scope,
          group_folder: groupFolder,
          kind: file.sourceType,
          text,
          importance_weight: baseImportance,
          embedding: null as number[] | null,
        }));

      if (chunks.length === 0) continue;
      const newChunks = chunks.filter(
        (chunk) => !this.store.chunkExists(chunk),
      );
      if (newChunks.length === 0) continue;

      const vectors = await this.embeddings.embedMany(
        newChunks.map((chunk) => chunk.text),
      );
      if (vectors.length !== newChunks.length) {
        throw new Error(
          `embedding provider returned ${vectors.length} vectors for ${newChunks.length} chunks`,
        );
      }
      newChunks.forEach((chunk, index) => {
        chunk.embedding = vectors[index] || null;
      });
      this.store.saveChunks(newChunks);
    }
  }

  async search(input: SearchInput): Promise<MemorySearchResult[]> {
    if (!RUNTIME_MEMORY_ENABLED) return [];
    try {
      this.indexer.reindexStaleFiles();
    } catch (err) {
      logger.warn({ err }, 'memory_reindex_failed');
    }
    const limit = input.limit ?? MEMORY_RETRIEVAL_LIMIT;
    const items = this.store.searchItemsByText(
      input.query,
      input.groupFolder,
      limit,
      input.userId,
    );
    const lexical = this.store.lexicalSearch(
      input.query,
      input.groupFolder,
      limit * 2,
    );

    let vector: MemorySearchResult[] = [];
    if (this.embeddings.isEnabled()) {
      const queryEmbedding = await this.embeddings.embedOne(input.query);
      vector = this.store.vectorSearch(
        queryEmbedding,
        input.groupFolder,
        limit * 2,
      );
    }

    const snippets = fuseSearchResults(lexical, vector, limit, {
      minScore: MEMORY_RETRIEVAL_MIN_SCORE,
      halfLifeDays: MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS,
      mmrLambda: MEMORY_MMR_LAMBDA,
      lexicalWeight: MEMORY_RRF_LEXICAL_WEIGHT,
      vectorWeight: MEMORY_RRF_VECTOR_WEIGHT,
      sourceTypeBoosts: MEMORY_SOURCE_TYPE_BOOSTS,
    });
    const filteredSnippets = input.source?.trim()
      ? snippets.filter((item) => item.source_type === input.source)
      : snippets;
    const filteredItems = input.source?.trim()
      ? items.filter((item) => item.source_type === input.source)
      : items;
    return mergeSearchResults(filteredItems, filteredSnippets, limit);
  }

  async saveMemory(
    input: SaveMemoryInput,
    ctx: MemoryWriteContext,
    precomputedEmbedding?: number[] | null,
  ): Promise<MemoryItem> {
    if (!RUNTIME_MEMORY_ENABLED) {
      throw new Error('memory is disabled');
    }
    const resolvedScope = this.resolveScope(input.scope, ctx);
    const scope =
      resolvedScope === 'user' && !input.user_id ? 'group' : resolvedScope;
    this.enforceScope(scope, ctx);
    const groupFolder = this.resolveTargetGroupFolder(input.group_folder, ctx);
    const confidence = clampConfidence(input.confidence);
    const kind = input.kind || 'fact';
    const source = input.source || 'agent';
    const actor = this.resolveWriteActor(ctx, source);
    this.assertNoSensitiveMaterialOrThrow({
      groupFolder,
      actor,
      scope,
      fields: [
        { name: 'key', value: input.key },
        { name: 'value', value: input.value },
        { name: 'why', value: input.why },
      ],
    });

    const existing = this.store.findItemByKey({
      scope,
      groupFolder,
      key: input.key,
      userId: input.user_id || null,
    });

    let embedding =
      precomputedEmbedding === undefined ? null : precomputedEmbedding;
    if (embedding === null && MEMORY_SEMANTIC_DEDUP_ENABLED) {
      embedding = await this.embeddings.embedOne(
        `${input.key}: ${input.value}`,
      );
    }

    if (existing) {
      const previousFilePath = existing.file_path;
      const patch = {
        key: input.key,
        value: input.value,
        why: input.why,
        load_bearing: input.load_bearing,
        source_turn_id: input.source_turn_id,
        kind,
        source,
        confidence,
      };
      const { memory, previousVersion } = this.patchItemWithRetry({
        initialItem: existing,
        reloadItem: () =>
          this.store.findItemByKey({
            scope,
            groupFolder,
            key: input.key,
            userId: input.user_id || null,
          }),
        patch,
      });
      const pinnedChanged = this.pinIfNeeded(memory);
      if (embedding) {
        this.persistEmbeddingBestEffort(memory, embedding, actor);
      }

      this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
        scope: memory.scope,
        group_folder: memory.group_folder,
        key: memory.key,
        confidence: memory.confidence,
        deduped: 'key',
      });
      this.appendJournal({
        kind: 'memory.item.patched',
        group_folder: memory.group_folder,
        scope: memory.scope,
        actor,
        payload: {
          ...memory,
          prev_version: previousVersion,
        },
      });
      if (pinnedChanged) {
        this.appendJournal({
          kind: 'memory.item.pinned',
          group_folder: memory.group_folder,
          scope: memory.scope,
          actor,
          payload: {
            id: memory.id,
            pinned: true,
          },
        });
      }

      const persisted = this.persistItemMarkdown(memory);
      this.store.setItemFileMetadata({
        itemId: memory.id,
        source_folder: 'items',
        file_path: persisted.filePath,
        content_hash: persisted.contentHash,
        indexed_at: persisted.indexedAt,
      });
      this.removeStaleItemFile(previousFilePath, persisted.filePath);
      this.indexer.indexFile(persisted.filePath);

      return memory;
    }

    if (MEMORY_SEMANTIC_DEDUP_ENABLED && embedding) {
      const similar = this.store.findSimilarItems({
        scope,
        groupFolder,
        userId: input.user_id || null,
        embedding,
        limit: 3,
      });
      const best = similar[0];
      if (best && best.similarity >= MEMORY_SEMANTIC_DEDUP_THRESHOLD) {
        const patch = {
          key: input.key,
          value: input.value,
          why: input.why,
          load_bearing: input.load_bearing,
          source_turn_id: input.source_turn_id,
          kind,
          source,
          confidence,
        };
        const { memory, previousVersion } = this.patchItemWithRetry({
          initialItem: best.item,
          reloadItem: () => this.store.getItemById(best.item.id),
          patch,
        });
        const previousFilePath = best.item.file_path;
        const pinnedChanged = this.pinIfNeeded(memory);
        this.persistEmbeddingBestEffort(memory, embedding, actor);
        this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
          scope: memory.scope,
          group_folder: memory.group_folder,
          key: memory.key,
          confidence: memory.confidence,
          deduped: 'semantic',
          similarity: best.similarity,
        });
        this.appendJournal({
          kind: 'memory.item.patched',
          group_folder: memory.group_folder,
          scope: memory.scope,
          actor,
          payload: {
            ...memory,
            prev_version: previousVersion,
          },
        });
        if (pinnedChanged) {
          this.appendJournal({
            kind: 'memory.item.pinned',
            group_folder: memory.group_folder,
            scope: memory.scope,
            actor,
            payload: {
              id: memory.id,
              pinned: true,
            },
          });
        }
        const persisted = this.persistItemMarkdown(memory);
        this.store.setItemFileMetadata({
          itemId: memory.id,
          source_folder: 'items',
          file_path: persisted.filePath,
          content_hash: persisted.contentHash,
          indexed_at: persisted.indexedAt,
        });
        this.removeStaleItemFile(previousFilePath, persisted.filePath);
        this.indexer.indexFile(persisted.filePath);
        return memory;
      }
    }

    const memory = this.store.saveItem({
      scope,
      group_folder: groupFolder,
      user_id: input.user_id || null,
      kind,
      key: input.key,
      value: input.value,
      why: input.why,
      load_bearing: input.load_bearing,
      source_turn_id: input.source_turn_id,
      source,
      confidence,
      is_pinned: confidence >= MEMORY_RETENTION_PIN_THRESHOLD,
    });
    const pinnedChanged = this.pinIfNeeded(memory);
    if (embedding) {
      this.persistEmbeddingBestEffort(memory, embedding, actor);
    }

    this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
      scope: memory.scope,
      group_folder: memory.group_folder,
      key: memory.key,
      confidence: memory.confidence,
      deduped: 'none',
    });
    this.appendJournal({
      kind: 'memory.item.saved',
      group_folder: memory.group_folder,
      scope: memory.scope,
      actor,
      payload: memory,
    });
    if (pinnedChanged) {
      this.appendJournal({
        kind: 'memory.item.pinned',
        group_folder: memory.group_folder,
        scope: memory.scope,
        actor,
        payload: {
          id: memory.id,
          pinned: true,
        },
      });
    }

    const persisted = this.persistItemMarkdown(memory);
    this.store.setItemFileMetadata({
      itemId: memory.id,
      source_folder: 'items',
      file_path: persisted.filePath,
      content_hash: persisted.contentHash,
      indexed_at: persisted.indexedAt,
    });
    this.indexer.indexFile(persisted.filePath);

    return memory;
  }

  patchMemory(input: PatchMemoryInput, ctx: MemoryWriteContext): MemoryItem {
    if (!RUNTIME_MEMORY_ENABLED) {
      throw new Error('memory is disabled');
    }
    const existing = this.store.getItemById(input.id);
    if (!existing) throw new Error('memory item not found');
    const previousFilePath = existing.file_path;
    this.enforcePatchAccess(existing.scope, existing.group_folder, ctx);
    const actor = this.resolveWriteActor(ctx, existing.source);
    this.assertNoSensitiveMaterialOrThrow({
      groupFolder: existing.group_folder,
      actor,
      scope: existing.scope,
      fields: [
        { name: 'key', value: input.key },
        { name: 'value', value: input.value },
        { name: 'why', value: input.why },
      ],
    });

    const patched = this.store.patchItem(input.id, input.expected_version, {
      key: input.key,
      value: input.value,
      why: input.why,
      load_bearing: input.load_bearing,
      confidence: input.confidence,
    });
    const pinnedChanged = this.pinIfNeeded(patched);

    this.store.recordEvent('memory_patched', 'memory_item', patched.id, {
      version: patched.version,
      confidence: patched.confidence,
    });
    this.appendJournal({
      kind: 'memory.item.patched',
      group_folder: patched.group_folder,
      scope: patched.scope,
      actor,
      payload: {
        ...patched,
        prev_version: existing.version,
      },
    });
    if (pinnedChanged) {
      this.appendJournal({
        kind: 'memory.item.pinned',
        group_folder: patched.group_folder,
        scope: patched.scope,
        actor,
        payload: {
          id: patched.id,
          pinned: true,
        },
      });
    }

    const persisted = this.persistItemMarkdown(patched);
    this.store.setItemFileMetadata({
      itemId: patched.id,
      source_folder: 'items',
      file_path: persisted.filePath,
      content_hash: persisted.contentHash,
      indexed_at: persisted.indexedAt,
    });
    this.removeStaleItemFile(previousFilePath, persisted.filePath);
    this.indexer.indexFile(persisted.filePath);

    return patched;
  }

  saveProcedure(
    input: SaveProcedureInput,
    ctx: MemoryWriteContext,
  ): MemoryProcedure {
    if (!RUNTIME_MEMORY_ENABLED) {
      throw new Error('memory is disabled');
    }
    const scope = this.resolveScope(input.scope, ctx);
    if (scope === 'user') {
      throw new Error('user-scoped procedures are not supported');
    }
    this.enforceScope(scope, ctx);
    const groupFolder = this.resolveTargetGroupFolder(input.group_folder, ctx);
    const actor = this.resolveWriteActor(ctx, input.source || 'agent');
    this.assertNoSensitiveMaterialOrThrow({
      groupFolder,
      actor,
      scope,
      fields: [
        { name: 'title', value: input.title },
        { name: 'body', value: input.body },
      ],
    });

    const procedure = this.store.saveProcedure({
      scope,
      group_folder: groupFolder,
      title: input.title,
      body: input.body,
      tags: input.tags || [],
      source: input.source || 'agent',
      origin: input.origin || 'explicit',
      trigger: input.trigger || null,
      confidence: clampConfidence(input.confidence),
    });

    this.store.recordEvent(
      'procedure_saved',
      'memory_procedure',
      procedure.id,
      {
        scope: procedure.scope,
        title: procedure.title,
        confidence: procedure.confidence,
      },
    );
    this.appendJournal({
      kind: 'memory.procedure.saved',
      group_folder: procedure.group_folder,
      scope: procedure.scope,
      actor,
      payload: procedure,
    });

    this.persistProcedureMarkdown(procedure);

    return procedure;
  }

  patchProcedure(
    input: PatchProcedureInput,
    ctx: MemoryWriteContext,
  ): MemoryProcedure {
    if (!RUNTIME_MEMORY_ENABLED) {
      throw new Error('memory is disabled');
    }
    const existing = this.store.getProcedureById(input.id);
    if (!existing) throw new Error('memory procedure not found');
    this.enforcePatchAccess(existing.scope, existing.group_folder, ctx);
    const actor = this.resolveWriteActor(ctx, existing.source);
    this.assertNoSensitiveMaterialOrThrow({
      groupFolder: existing.group_folder,
      actor,
      scope: existing.scope,
      fields: [
        { name: 'title', value: input.title },
        { name: 'body', value: input.body },
      ],
    });
    const previousFilePath = this.getProcedureMarkdownPath(existing);

    const patched = this.store.patchProcedure(
      input.id,
      input.expected_version,
      {
        title: input.title,
        body: input.body,
        tags: input.tags,
        trigger: input.trigger,
        confidence: input.confidence,
      },
    );

    this.store.recordEvent(
      'procedure_patched',
      'memory_procedure',
      patched.id,
      {
        version: patched.version,
        confidence: patched.confidence,
      },
    );
    this.appendJournal({
      kind: 'memory.procedure.patched',
      group_folder: patched.group_folder,
      scope: patched.scope,
      actor,
      payload: patched,
    });

    const currentFilePath = this.persistProcedureMarkdown(patched);
    if (previousFilePath !== currentFilePath) {
      this.removeManagedMemoryFile(previousFilePath, 'procedures');
    }

    return patched;
  }

  async buildBrief(input: BuildBriefInput): Promise<string> {
    if (!RUNTIME_MEMORY_ENABLED) return 'No durable memory available yet.';
    const resolvedUserId = input.userId?.trim() || undefined;
    const userScopedItems = resolvedUserId
      ? this.store.listTopItems(
          'user',
          input.groupFolder,
          input.maxItems,
          resolvedUserId,
        )
      : [];
    const scoped = dedupeItemsById([
      ...userScopedItems,
      ...this.store.listTopItems('group', input.groupFolder, input.maxItems),
      ...this.store.listTopItems('global', input.groupFolder, input.maxItems),
    ])
      .sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) {
          return Number(b.is_pinned) - Number(a.is_pinned);
        }
        if (b.confidence !== a.confidence) {
          return b.confidence - a.confidence;
        }
        const aLast = Date.parse(a.last_retrieved_at || a.updated_at);
        const bLast = Date.parse(b.last_retrieved_at || b.updated_at);
        return bLast - aLast;
      })
      .slice(0, input.maxItems);
    const procedures = this.store.listTopProcedures(input.groupFolder, 5);

    for (const item of scoped) {
      this.store.touchItem(item.id);
    }

    const decisions = scoped.filter((item) => item.kind === 'decision');
    const facts = scoped.filter((item) => item.kind !== 'decision');

    const lines: string[] = ['## Memory Brief', ''];
    if (decisions.length > 0) {
      lines.push('### Active Decisions');
      for (const item of decisions) {
        lines.push(`- (${item.scope}) ${truncate(item.value, 220)}`);
      }
      lines.push('');
    }

    if (facts.length > 0) {
      lines.push('### Facts');
      for (const item of facts) {
        lines.push(`- (${item.scope}) ${truncate(item.value, 220)}`);
      }
      lines.push('');
    }

    if (procedures.length > 0) {
      lines.push('### Procedures');
      for (const procedure of procedures) {
        lines.push(
          `- **${truncate(procedure.title, 120)}**: ${truncate(procedure.body, 220)}`,
        );
      }
      lines.push('');
    }

    if (
      decisions.length === 0 &&
      facts.length === 0 &&
      procedures.length === 0
    ) {
      lines.push('No durable memory available yet.');
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  async extractFromTranscript(input: TranscriptExtractionInput): Promise<void> {
    if (!RUNTIME_MEMORY_ENABLED) return;
    MemoryService.incrementCounter('extractions_total');
    try {
      const resolvedUserId = input.userId?.trim() || undefined;
      const turns = parseTranscriptArc(
        input.transcriptPath,
        MEMORY_EXTRACTOR_MAX_TURNS,
      );
      if (turns.length === 0) {
        const payload = {
          group_folder: input.groupFolder,
          trigger: input.trigger,
          transcript_path: input.transcriptPath,
          session_id: input.sessionId || null,
          facts_extracted: 0,
          facts_saved: 0,
        };
        this.store.recordEvent(
          'reflection_completed',
          'reflection',
          input.groupFolder,
          payload,
        );
        this.appendJournal({
          kind: 'reflection.completed',
          group_folder: input.groupFolder,
          actor: `extractor:${input.trigger}`,
          payload,
        });
        return;
      }

      const userScopedItems = resolvedUserId
        ? this.store.listTopItems('user', input.groupFolder, 10, resolvedUserId)
        : [];
      const retrievedItems = dedupeItemsById([
        ...this.store.listTopItems('group', input.groupFolder, 10),
        ...this.store.listTopItems('global', input.groupFolder, 10),
        ...userScopedItems,
      ]).slice(0, 10);
      const supersedeCandidatesById = new Map<string, MemoryItem>(
        retrievedItems.map((item) => [item.id, item]),
      );

      let extractorUsage: MemoryExtractorUsage | undefined;
      const extractedFacts = await this.extractor.extractFacts({
        turns,
        trigger: input.trigger,
        userId: resolvedUserId,
        retrievedItems: retrievedItems.map((item) => ({
          id: item.id,
          key: item.key,
          value: item.value,
        })),
        onUsage: (usage) => {
          extractorUsage = usage;
        },
      });
      if (extractorUsage) {
        this.store.recordEvent(
          'memory_extractor_usage',
          'memory_extractor',
          input.groupFolder,
          {
            trigger: input.trigger,
            model: extractorUsage.model,
            input_tokens: extractorUsage.input_tokens,
            output_tokens: extractorUsage.output_tokens,
            cache_read_input_tokens: extractorUsage.cache_read_input_tokens,
            cache_creation_input_tokens:
              extractorUsage.cache_creation_input_tokens,
          },
        );
        MemoryService.incrementCounter(
          'cache_read_tokens_total',
          extractorUsage.cache_read_input_tokens ?? 0,
        );
        MemoryService.incrementCounter(
          'cache_creation_tokens_total',
          extractorUsage.cache_creation_input_tokens ?? 0,
        );
      }

      const writableFacts: typeof extractedFacts = [];
      for (const fact of extractedFacts) {
        if (fact.confidence < MEMORY_EXTRACTOR_MIN_CONFIDENCE) continue;
        const sensitiveKeyReason = classifySensitiveMemoryMaterial(fact.key);
        if (sensitiveKeyReason) {
          MemoryService.incrementCounter('facts_filtered_sensitive_total');
          this.store.recordEvent(
            'sensitive_material_filtered',
            'memory_extractor',
            input.groupFolder,
            {
              trigger: input.trigger,
              scope: fact.scope,
              key_fingerprint: fingerprintSensitiveToken(fact.key),
              field: 'key',
              reason: sensitiveKeyReason,
            },
          );
          continue;
        }
        const sensitiveValueReason = classifySensitiveMemoryMaterial(
          fact.value,
        );
        if (sensitiveValueReason) {
          MemoryService.incrementCounter('facts_filtered_sensitive_total');
          this.store.recordEvent(
            'sensitive_material_filtered',
            'memory_extractor',
            input.groupFolder,
            {
              trigger: input.trigger,
              scope: fact.scope,
              key_fingerprint: fingerprintSensitiveToken(fact.key),
              field: 'value',
              reason: sensitiveValueReason,
            },
          );
          continue;
        }
        const sensitiveWhyReason = fact.why
          ? classifySensitiveMemoryMaterial(fact.why)
          : null;
        if (sensitiveWhyReason) {
          MemoryService.incrementCounter('facts_filtered_sensitive_total');
          this.store.recordEvent(
            'sensitive_material_filtered',
            'memory_extractor',
            input.groupFolder,
            {
              trigger: input.trigger,
              scope: fact.scope,
              key_fingerprint: fingerprintSensitiveToken(fact.key),
              field: 'why',
              reason: sensitiveWhyReason,
            },
          );
          continue;
        }
        writableFacts.push(fact);
      }

      let factEmbeddings: number[][] = [];
      if (writableFacts.length > 0 && MEMORY_SEMANTIC_DEDUP_ENABLED) {
        factEmbeddings = await this.embeddings.embedMany(
          writableFacts.map((fact) => `${fact.key}: ${fact.value}`),
        );
        if (factEmbeddings.length !== writableFacts.length) {
          throw new Error(
            `embedding provider returned ${factEmbeddings.length} vectors for ${writableFacts.length} facts`,
          );
        }
      }

      let savedFacts = 0;
      for (let i = 0; i < writableFacts.length; i += 1) {
        const fact = writableFacts[i]!;
        if (fact.scope === 'global') {
          continue;
        }
        const saved = await this.saveMemory(
          {
            scope: fact.scope,
            group_folder: input.groupFolder,
            user_id: fact.user_id,
            key: fact.key,
            value: fact.value,
            why: fact.why,
            load_bearing: fact.load_bearing,
            source_turn_id: fact.source_turn_id,
            kind: fact.kind,
            confidence: fact.confidence,
            source: input.trigger,
          },
          {
            isMain: false,
            groupFolder: input.groupFolder,
            actor: `extractor:${input.trigger}`,
          },
          factEmbeddings[i] || null,
        );
        if (Array.isArray(fact.supersedes)) {
          const validSupersedeIds = new Set<string>();
          for (const id of fact.supersedes) {
            if (!id) continue;
            const candidate = supersedeCandidatesById.get(id);
            if (!candidate) continue;
            if (candidate.group_folder !== input.groupFolder) continue;
            if (candidate.scope !== saved.scope) continue;
            if (
              candidate.scope === 'user' &&
              saved.user_id &&
              candidate.user_id !== saved.user_id
            ) {
              continue;
            }
            validSupersedeIds.add(id);
          }
          for (const id of validSupersedeIds) {
            this.store.softDeleteItem(id, saved.id);
            this.appendJournal({
              kind: 'memory.item.superseded',
              group_folder: input.groupFolder,
              scope: saved.scope,
              actor: `extractor:${input.trigger}`,
              payload: {
                id,
                superseded_by: saved.id,
              },
            });
          }
        }
        savedFacts += 1;
      }
      MemoryService.incrementCounter('facts_saved_total', savedFacts);

      this.applyRetentionWithJournal(
        input.groupFolder,
        `retention:${input.trigger}`,
      );
      const consolidation = await this.consolidateGroupMemory(
        input.groupFolder,
      );

      const reflectionPayload = {
        group_folder: input.groupFolder,
        trigger: input.trigger,
        transcript_path: input.transcriptPath,
        session_id: input.sessionId || null,
        facts_extracted: extractedFacts.length,
        facts_saved: savedFacts,
        consolidation,
      };
      this.store.recordEvent(
        'reflection_completed',
        'reflection',
        input.groupFolder,
        reflectionPayload,
      );
      this.appendJournal({
        kind: 'reflection.completed',
        group_folder: input.groupFolder,
        actor: `extractor:${input.trigger}`,
        payload: reflectionPayload,
      });
    } catch (err) {
      MemoryService.incrementCounter('extractions_failed_total');
      throw err;
    }
  }

  private applyRetentionWithJournal(groupFolder: string, actor: string): void {
    const retention = this.store.applyRetentionPolicies(groupFolder);
    for (const id of retention.removedItemIds) {
      this.appendJournal({
        kind: 'memory.item.superseded',
        group_folder: groupFolder,
        actor,
        payload: {
          id,
          superseded_by: null,
          reason: 'retention',
        },
      });
    }
    for (const id of retention.removedProcedureIds) {
      this.removeProcedureMirrorById(id);
      this.appendJournal({
        kind: 'memory.procedure.deleted',
        group_folder: groupFolder,
        actor,
        payload: {
          id,
          reason: 'retention',
        },
      });
    }
    if (
      retention.removedItemIds.length > 0 ||
      retention.removedProcedureIds.length > 0 ||
      retention.evictedChunkIds.length > 0
    ) {
      this.appendJournal({
        kind: 'retention.applied',
        group_folder: groupFolder,
        actor,
        payload: {
          removed_item_ids: retention.removedItemIds,
          removed_procedure_ids: retention.removedProcedureIds,
          evicted_chunk_ids: retention.evictedChunkIds,
        },
      });
    }
  }

  private pinIfNeeded(memory: MemoryItem): boolean {
    if (memory.is_pinned) return false;
    if (memory.confidence < MEMORY_RETENTION_PIN_THRESHOLD) return false;
    this.store.pinItem(memory.id, true);
    memory.is_pinned = true;
    return true;
  }

  private resolveScope(
    scope: MemoryScope | undefined,
    ctx: MemoryWriteContext,
  ): MemoryScope {
    if (scope) return scope;
    if (MEMORY_SCOPE_POLICY === 'global') {
      return ctx.isMain ? 'global' : 'group';
    }
    return 'group';
  }

  private enforceScope(scope: MemoryScope, ctx: MemoryWriteContext): void {
    if (scope === 'global' && !ctx.isMain) {
      throw new Error(
        'global memory writes are allowed only from main/admin context',
      );
    }
  }

  private enforcePatchAccess(
    scope: MemoryScope,
    groupFolder: string,
    ctx: MemoryWriteContext,
  ): void {
    if (ctx.isMain) return;
    if (scope === 'global') {
      throw new Error(
        'global memory writes are allowed only from main/admin context',
      );
    }
    if (groupFolder !== ctx.groupFolder) {
      throw new Error('memory writes are limited to the caller group');
    }
  }

  private resolveTargetGroupFolder(
    requestedGroupFolder: string | undefined,
    ctx: MemoryWriteContext,
  ): string {
    if (ctx.isMain && requestedGroupFolder) {
      return requestedGroupFolder;
    }
    return ctx.groupFolder;
  }

  private resolveWriteActor(ctx: MemoryWriteContext, source?: string): string {
    const explicit = ctx.actor?.trim();
    if (explicit) return explicit;
    const normalized = source?.trim().toLowerCase();
    if (normalized === 'precompact' || normalized === 'session-end') {
      return `extractor:${normalized}`;
    }
    if (normalized === 'consolidation') {
      return 'consolidation';
    }
    if (normalized === 'dreaming') {
      return 'dreaming';
    }
    if (normalized === 'mcp-tool') {
      return 'mcp-tool';
    }
    return 'agent';
  }

  private patchItemWithRetry(input: {
    initialItem: MemoryItem;
    reloadItem: () => MemoryItem | null;
    patch: {
      key: string;
      value: string;
      why?: string;
      load_bearing?: boolean;
      source_turn_id?: string;
      kind: MemoryItem['kind'];
      source: string;
      confidence: number;
    };
  }): { memory: MemoryItem; previousVersion: number } {
    let current = input.initialItem;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const memory = this.store.patchItem(current.id, current.version, {
          ...input.patch,
        });
        return {
          memory,
          previousVersion: current.version,
        };
      } catch (err) {
        if (!isStalePatchError(err) || attempt > 0) {
          throw err;
        }
        MemoryService.incrementCounter('stale_patch_retries_total');
        const refreshed = input.reloadItem();
        if (!refreshed) {
          throw err;
        }
        current = refreshed;
      }
    }
    throw new Error('patch retry failed');
  }

  private assertNoSensitiveMaterialOrThrow(input: {
    groupFolder: string;
    actor: string;
    scope: MemoryScope;
    fields: Array<{
      name: string;
      value?: string | null;
    }>;
  }): void {
    for (const field of input.fields) {
      const value = field.value?.trim();
      if (!value) continue;
      const reason = classifySensitiveMemoryMaterial(value);
      if (!reason) continue;
      MemoryService.incrementCounter('facts_filtered_sensitive_total');
      this.store.recordEvent(
        'sensitive_material_filtered',
        'memory_write',
        input.groupFolder,
        {
          actor: input.actor,
          scope: input.scope,
          field: field.name,
          reason,
        },
      );
      throw new Error(
        `sensitive material blocked in memory write (${field.name})`,
      );
    }
  }

  private persistEmbeddingBestEffort(
    memory: MemoryItem,
    embedding: number[] | null,
    actor: string,
  ): void {
    if (!embedding) return;
    try {
      this.store.saveItemEmbedding(memory.id, embedding);
    } catch (err) {
      logger.warn(
        {
          err,
          itemId: memory.id,
          scope: memory.scope,
          group_folder: memory.group_folder,
          actor,
        },
        'memory_embedding_persist_failed',
      );
      this.store.recordEvent(
        'memory_embedding_persist_failed',
        'memory_item',
        memory.id,
        {
          scope: memory.scope,
          group_folder: memory.group_folder,
          actor,
          reason: err instanceof Error ? err.message : String(err),
          fallback: 'keyword_only',
        },
      );
    }
  }

  private persistItemMarkdown(memory: MemoryItem): {
    filePath: string;
    contentHash: string;
    indexedAt: string;
  } {
    const slugBase = sanitizePathSegment(memory.key || memory.id, 'memory');
    const slugId = sanitizePathSegment(memory.id, 'item');
    const filePath = path.join(
      MEMORY_ROOT,
      'items',
      sanitizePathSegment(memory.kind, 'fact'),
      `${slugBase}-${slugId}.md`,
    );
    const body = [
      '---',
      `id: ${memory.id}`,
      `scope: ${memory.scope}`,
      `group_folder: ${memory.group_folder}`,
      ...(memory.user_id ? [`user_id: ${memory.user_id}`] : []),
      `kind: ${memory.kind}`,
      `key: ${yamlSafe(memory.key)}`,
      `source: ${memory.source}`,
      `confidence: ${memory.confidence}`,
      `version: ${memory.version}`,
      `pinned: ${memory.is_pinned ? 'true' : 'false'}`,
      `load_bearing: ${memory.load_bearing ? 'true' : 'false'}`,
      `created_at: ${memory.created_at}`,
      `updated_at: ${memory.updated_at}`,
      '---',
      '',
      '## Value',
      memory.value.trim(),
      '',
      '## Why',
      (memory.why || '').trim(),
      '',
    ].join('\n');
    writeFileAtomic(filePath, body);
    return {
      filePath,
      contentHash: sha256(body),
      indexedAt: new Date().toISOString(),
    };
  }

  private getProcedureMarkdownPath(procedure: MemoryProcedure): string {
    const slugBase = sanitizePathSegment(
      procedure.title || procedure.id,
      'procedure',
    );
    const slugId = sanitizePathSegment(procedure.id, 'procedure');
    return path.join(MEMORY_ROOT, 'procedures', `${slugBase}-${slugId}.md`);
  }

  private persistProcedureMarkdown(procedure: MemoryProcedure): string {
    const slugBase = sanitizePathSegment(
      procedure.title || procedure.id,
      'procedure',
    );
    const filePath = this.getProcedureMarkdownPath(procedure);
    const body = [
      '---',
      `id: ${procedure.id}`,
      `scope: ${procedure.scope}`,
      `group_folder: ${procedure.group_folder}`,
      `slug: ${slugBase}`,
      `version: ${procedure.version}`,
      `tags: [${(procedure.tags || []).map((tag) => yamlSafe(tag)).join(', ')}]`,
      `created_at: ${procedure.created_at}`,
      `updated_at: ${procedure.updated_at}`,
      '---',
      '',
      '## Purpose',
      procedure.title.trim(),
      '',
      '## Steps',
      procedure.body.trim(),
      '',
    ].join('\n');
    writeFileAtomic(filePath, body);
    return filePath;
  }

  private removeStaleItemFile(
    previousFilePath: string | null | undefined,
    currentFilePath: string,
  ): void {
    if (!previousFilePath) return;
    const previousResolved = path.resolve(previousFilePath);
    const currentResolved = path.resolve(currentFilePath);
    if (previousResolved === currentResolved) return;
    this.removeManagedMemoryFile(previousResolved, 'items');
  }

  private removeProcedureMirrorById(procedureId: string): void {
    const normalizedId = sanitizePathSegment(procedureId, 'procedure');
    const proceduresDir = path.join(MEMORY_ROOT, 'procedures');
    if (!fs.existsSync(proceduresDir)) return;
    const suffix = `-${normalizedId}.md`;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(proceduresDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(suffix)) continue;
      this.removeManagedMemoryFile(path.join(proceduresDir, entry.name), '.');
    }
  }

  private removeManagedMemoryFile(
    filePath: string,
    managedSubdir: string,
  ): void {
    const managedRoot =
      managedSubdir === '.'
        ? MEMORY_ROOT
        : path.join(MEMORY_ROOT, managedSubdir);
    if (!isInsideRoot(managedRoot, filePath)) return;
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
    } catch {
      return;
    }
    fs.rmSync(filePath, { force: true });
  }

  private appendJournal(input: JournalAppendInput): void {
    try {
      this.journal.append(input);
    } catch (err) {
      MemoryService.incrementCounter('journal_writes_failed_total');
      logger.error(
        {
          err,
          kind: input.kind,
          group_folder: input.group_folder,
          actor: input.actor,
        },
        'journal_write_failed',
      );
      try {
        this.store.recordEvent(
          'journal_write_failed',
          'memory_journal',
          input.group_folder,
          {
            kind: input.kind,
            actor: input.actor,
            error:
              err instanceof Error ? err.message : String(err || 'unknown'),
          },
        );
      } catch (recordErr) {
        logger.error({ err: recordErr }, 'journal_write_failed_record_failed');
      }
    }
  }
}

function isStalePatchError(err: unknown): boolean {
  return err instanceof Error && /stale patch/i.test(err.message);
}

function sanitizePathSegment(input: string, fallback: string): string {
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function yamlSafe(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeRealpathSync(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function resolvePathWithRealParent(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  let existingParent = path.dirname(resolved);
  while (!fs.existsSync(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) break;
    existingParent = parent;
  }
  const parentReal = safeRealpathSync(existingParent);
  const tail = path.relative(existingParent, resolved);
  return path.resolve(parentReal, tail);
}

function isInsideRoot(rootDir: string, candidatePath: string): boolean {
  const rootResolved = safeRealpathSync(rootDir);
  const candidateResolved = resolvePathWithRealParent(candidatePath);
  const relative = path.relative(rootResolved, candidateResolved);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function fingerprintSensitiveToken(value: string): string {
  const hash = sha256(value);
  return `${hash.slice(0, 12)}:${value.length}`;
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return chunks;

  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + size);
    chunks.push(normalized.slice(start, end));
    if (end === normalized.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string',
    )
    .map((part) => part.text as string)
    .join('');
}

function parseTranscriptArc(
  transcriptPath: string,
  maxTurns: number,
): ArcTurn[] {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const turns: ArcTurn[] = [];

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      const candidate = JSON.parse(trimmed) as unknown;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        continue;
      }
      parsed = candidate as Record<string, unknown>;
    } catch {
      continue;
    }

    const roleRaw =
      (typeof parsed.type === 'string' ? parsed.type : undefined) ||
      (typeof parsed.role === 'string' ? parsed.role : undefined);
    const normalizedRole = roleRaw?.trim().toLowerCase();
    if (normalizedRole !== 'user' && normalizedRole !== 'assistant') {
      continue;
    }

    const message = parsed.message;
    const contentValue =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>).content
        : parsed.content;
    const text =
      normalizedRole === 'user'
        ? extractUserText(contentValue).trim()
        : extractAssistantText(contentValue).trim();
    if (!text) continue;
    turns.push({ role: normalizedRole, text });
  }

  if (turns.length <= maxTurns) return turns;
  return turns.slice(turns.length - maxTurns);
}

function mergeSearchResults(
  items: MemorySearchResult[],
  snippets: MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  const byId = new Map<string, MemorySearchResult>();
  for (const result of [...items, ...snippets]) {
    const existing = byId.get(result.id);
    if (
      !existing ||
      result.fused_score + result.lexical_score + result.vector_score >
        existing.fused_score + existing.lexical_score + existing.vector_score
    ) {
      byId.set(result.id, result);
    }
  }
  return [...byId.values()]
    .sort((a, b) => {
      const aScore = a.fused_score + a.lexical_score + a.vector_score;
      const bScore = b.fused_score + b.lexical_score + b.vector_score;
      return bScore - aScore;
    })
    .slice(0, limit);
}

function dedupeItemsById(items: MemoryItem[]): MemoryItem[] {
  const byId = new Map<string, MemoryItem>();
  for (const item of items) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

function directorySizeKb(root: string): number {
  if (!root || !fs.existsSync(root)) return 0;
  let totalBytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile()) {
          totalBytes += fs.statSync(full).size;
        }
      } catch {
        // Best-effort accounting.
      }
    }
  }
  return Math.round(totalBytes / 1024);
}

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  MEMORY_CHUNK_OVERLAP,
  MEMORY_CHUNK_SIZE,
  MEMORY_CONFIDENCE_BOOST_ON_USE,
  MEMORY_CONFIDENCE_DECAY_ON_UNUSED,
  MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD,
  MEMORY_CONSOLIDATION_ENABLED,
  MEMORY_CONSOLIDATION_MAX_CLUSTERS,
  MEMORY_CONSOLIDATION_MIN_ITEMS,
  MEMORY_DREAMING_CONFIDENCE_BOOST,
  MEMORY_DREAMING_CONFIDENCE_DECAY,
  MEMORY_DREAMING_DECAY_THRESHOLD,
  MEMORY_DREAMING_ENABLED,
  MEMORY_DREAMING_MIN_RECALLS,
  MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
  MEMORY_DREAMING_PROMOTION_THRESHOLD,
  MEMORY_GLOBAL_KNOWLEDGE_DIR,
  MEMORY_REFLECTION_MAX_FACTS_PER_TURN,
  MEMORY_REFLECTION_MIN_CONFIDENCE,
  MEMORY_MMR_LAMBDA,
  MEMORY_RETRIEVAL_MIN_SCORE,
  MEMORY_RETENTION_PIN_THRESHOLD,
  MEMORY_RRF_LEXICAL_WEIGHT,
  MEMORY_RRF_VECTOR_WEIGHT,
  MEMORY_RETRIEVAL_LIMIT,
  MEMORY_SEMANTIC_DEDUP_ENABLED,
  MEMORY_SEMANTIC_DEDUP_THRESHOLD,
  MEMORY_SOURCE_TYPE_BOOSTS,
  MEMORY_SCOPE_POLICY,
  MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS,
  MEMORY_USAGE_DECAY_INTERVAL_TURNS,
  MEMORY_USAGE_FEEDBACK_ENABLED,
} from '../core/config.js';
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
  containsSensitiveMaterial,
  createMemoryExtractionProvider,
  MemoryExtractionProvider,
} from './memory-extractor.js';
import {
  ChunkInsert,
  createMemoryProvider,
  MemoryProvider,
} from './memory-provider.js';
import { fuseSearchResults } from './memory-retrieval.js';
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
}

interface ReflectionInput {
  groupFolder: string;
  prompt: string;
  result: string;
  isMain: boolean;
  userId?: string;
  retrievedItemIds?: string[];
}

interface MemoryContextResult {
  block: string;
  facts: MemoryItem[];
  procedures: MemoryProcedure[];
  snippets: MemorySearchResult[];
  recentWork: string[];
  retrievedItemIds: string[];
}

interface SourceDoc {
  sourceId: string;
  sourcePath: string;
  sourceType: string;
  text: string;
}

let memoryServiceSingleton: MemoryService | null = null;

export class MemoryService {
  private readonly store: MemoryProvider;
  private readonly embeddings: EmbeddingProvider;
  private readonly extractor: MemoryExtractionProvider;

  constructor(
    store: MemoryProvider = createMemoryProvider(),
    embeddings: EmbeddingProvider = createEmbeddingProvider(),
    extractor: MemoryExtractionProvider = createMemoryExtractionProvider(),
  ) {
    this.store = store;
    this.embeddings = new CachedEmbeddingProvider(embeddings, this.store);
    this.extractor = extractor;
    this.embeddings.validateConfiguration();
  }

  static getInstance(): MemoryService {
    if (!memoryServiceSingleton) {
      memoryServiceSingleton = new MemoryService();
    }
    return memoryServiceSingleton;
  }

  static closeInstance(): void {
    memoryServiceSingleton?.store.close();
    memoryServiceSingleton = null;
  }

  getProviderName(): string {
    return this.store.providerName || 'unknown';
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
    return runMemoryDreamingSweep({
      groupFolder,
      store: this.store,
      consolidationEnabled: MEMORY_CONSOLIDATION_ENABLED,
      consolidateGroupMemory: (targetGroupFolder) =>
        this.consolidateGroupMemory(targetGroupFolder),
      retentionPinThreshold: MEMORY_RETENTION_PIN_THRESHOLD,
      promotionThreshold: MEMORY_DREAMING_PROMOTION_THRESHOLD,
      decayThreshold: MEMORY_DREAMING_DECAY_THRESHOLD,
      minRecalls: MEMORY_DREAMING_MIN_RECALLS,
      minUniqueQueries: MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
      confidenceBoost: MEMORY_DREAMING_CONFIDENCE_BOOST,
      confidenceDecay: MEMORY_DREAMING_CONFIDENCE_DECAY,
      enabled: MEMORY_DREAMING_ENABLED,
    });
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

    this.store.applyRetentionPolicies(groupFolder);
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
    this.store.applyRetentionPolicies(MEMORY_GLOBAL_GROUP_FOLDER);
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
    return mergeSearchResults(items, snippets, limit);
  }

  async saveMemory(
    input: SaveMemoryInput,
    ctx: MemoryWriteContext,
    precomputedEmbedding?: number[] | null,
  ): Promise<MemoryItem> {
    const resolvedScope = this.resolveScope(input.scope, ctx);
    const scope =
      resolvedScope === 'user' && !input.user_id ? 'group' : resolvedScope;
    this.enforceScope(scope, ctx);
    const groupFolder = this.resolveTargetGroupFolder(input.group_folder, ctx);
    const confidence = clampConfidence(input.confidence);
    const kind = input.kind || 'fact';
    const source = input.source || 'agent';

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
      const memory = this.store.patchItem(existing.id, existing.version, {
        key: input.key,
        value: input.value,
        kind,
        source,
        confidence,
      });
      this.pinIfNeeded(memory.id, memory.confidence);
      if (embedding) {
        this.store.saveItemEmbedding(memory.id, embedding);
      }

      this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
        scope: memory.scope,
        group_folder: memory.group_folder,
        key: memory.key,
        confidence: memory.confidence,
        deduped: 'key',
      });

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
        const memory = this.store.patchItem(best.item.id, best.item.version, {
          key: input.key,
          value: input.value,
          kind,
          source,
          confidence,
        });
        this.pinIfNeeded(memory.id, memory.confidence);
        this.store.saveItemEmbedding(memory.id, embedding);
        this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
          scope: memory.scope,
          group_folder: memory.group_folder,
          key: memory.key,
          confidence: memory.confidence,
          deduped: 'semantic',
          similarity: best.similarity,
        });
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
      source,
      confidence,
      is_pinned: confidence >= MEMORY_RETENTION_PIN_THRESHOLD,
    });
    this.pinIfNeeded(memory.id, memory.confidence);
    if (embedding) {
      this.store.saveItemEmbedding(memory.id, embedding);
    }

    this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
      scope: memory.scope,
      group_folder: memory.group_folder,
      key: memory.key,
      confidence: memory.confidence,
      deduped: 'none',
    });

    return memory;
  }

  patchMemory(input: PatchMemoryInput, ctx: MemoryWriteContext): MemoryItem {
    const existing = this.store.getItemById(input.id);
    if (!existing) throw new Error('memory item not found');
    this.enforcePatchAccess(existing.scope, existing.group_folder, ctx);

    const patched = this.store.patchItem(input.id, input.expected_version, {
      key: input.key,
      value: input.value,
      confidence: input.confidence,
    });
    this.pinIfNeeded(patched.id, patched.confidence);

    this.store.recordEvent('memory_patched', 'memory_item', patched.id, {
      version: patched.version,
      confidence: patched.confidence,
    });

    return patched;
  }

  saveProcedure(
    input: SaveProcedureInput,
    ctx: MemoryWriteContext,
  ): MemoryProcedure {
    const scope = this.resolveScope(input.scope, ctx);
    if (scope === 'user') {
      throw new Error('user-scoped procedures are not supported');
    }
    this.enforceScope(scope, ctx);

    const procedure = this.store.saveProcedure({
      scope,
      group_folder: this.resolveTargetGroupFolder(input.group_folder, ctx),
      title: input.title,
      body: input.body,
      tags: input.tags || [],
      source: input.source || 'agent',
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

    return procedure;
  }

  patchProcedure(
    input: PatchProcedureInput,
    ctx: MemoryWriteContext,
  ): MemoryProcedure {
    const existing = this.store.getProcedureById(input.id);
    if (!existing) throw new Error('memory procedure not found');
    this.enforcePatchAccess(existing.scope, existing.group_folder, ctx);

    const patched = this.store.patchProcedure(
      input.id,
      input.expected_version,
      {
        title: input.title,
        body: input.body,
        tags: input.tags,
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

    return patched;
  }

  async buildMemoryContext(
    prompt: string,
    groupFolder: string,
    _isMain: boolean,
    userId?: string,
  ): Promise<MemoryContextResult> {
    const facts = selectBriefItems(
      dedupeItemsById([
        ...this.store.listTopItems('user', groupFolder, 5, userId),
        ...this.store.listTopItems('group', groupFolder, 8),
        ...this.store.listTopItems('global', groupFolder, 4),
      ]),
      12,
    );
    const retrievedItemIds = facts.map((fact) => fact.id);

    const procedures = this.store.listTopProcedures(groupFolder, 3);
    const snippets = isNoiseQuery(prompt)
      ? []
      : await this.search({
          query: prompt,
          groupFolder,
          limit: MEMORY_RETRIEVAL_LIMIT,
        });

    const recentWork =
      /what were we working on|where did we leave off|resume|continue|pick up/i.test(
        prompt,
      )
        ? snippets
            .filter((s) => s.source_type === 'conversation')
            .slice(0, 3)
            .map((s) => summarizeLine(s.text))
        : [];

    for (const fact of facts) {
      this.store.touchItem(fact.id);
    }
    if (MEMORY_USAGE_FEEDBACK_ENABLED && retrievedItemIds.length > 0) {
      const queryHash = hashPrompt(prompt);
      for (const fact of facts) {
        this.store.recordRetrievalSignal(fact.id, fact.confidence, queryHash);
      }
    }

    const lines: string[] = [];
    lines.push('[Memory Brief]');
    if (facts.length > 0) {
      const userPreferences = facts.filter(
        (item) => item.kind === 'preference',
      );
      const activeDecisions = facts.filter((item) => item.kind === 'decision');
      const constraints = facts.filter(
        (item) => item.kind === 'constraint' || item.kind === 'correction',
      );
      const projectFacts = facts.filter(
        (item) =>
          item.kind !== 'preference' &&
          item.kind !== 'decision' &&
          item.kind !== 'constraint' &&
          item.kind !== 'correction',
      );

      appendMemoryItems(lines, 'User Preferences', userPreferences);
      appendMemoryItems(lines, 'Active Decisions', activeDecisions);
      appendMemoryItems(lines, 'Corrections and Constraints', constraints);
      appendMemoryItems(lines, 'Project Facts', projectFacts);
    } else {
      lines.push('No durable facts are available yet.');
    }
    if (procedures.length > 0) {
      lines.push('Reusable Procedures:');
      for (const proc of procedures) {
        lines.push(
          `- (${proc.scope}) ${proc.title}: ${truncate(proc.body, 220)}`,
        );
      }
    }
    if (recentWork.length > 0) {
      lines.push('Recent Work Recap:');
      for (const row of recentWork) {
        lines.push(`- ${row}`);
      }
    }

    const memoryMatches = snippets
      .filter((snippet) => snippet.source_type === 'memory_item')
      .slice(0, 4);
    const sourceSnippets = snippets.filter(
      (snippet) => snippet.source_type !== 'memory_item',
    );

    if (memoryMatches.length > 0) {
      lines.push('Relevant Memory Matches:');
      for (const match of memoryMatches) {
        lines.push(`- (${match.scope}) ${truncate(match.text, 180)}`);
      }
    }

    if (sourceSnippets.length > 0) {
      lines.push('Relevant Source Snippets:');
      for (const snippet of sourceSnippets.slice(0, 4)) {
        lines.push(
          `- [${formatSnippetSourceLabel(snippet)}] ${truncate(snippet.text, 220)}`,
        );
      }
    }

    return {
      block: lines.join('\n'),
      facts,
      procedures,
      snippets,
      recentWork,
      retrievedItemIds,
    };
  }

  async reflectAfterTurn(input: ReflectionInput): Promise<void> {
    if (!input.result.trim()) return;

    const combined = `${input.prompt}\n${input.result}`;
    if (containsSensitiveMaterial(combined)) {
      this.store.recordEvent('reflection_skipped', 'reflection', null, {
        reason: 'sensitive_material',
        group_folder: input.groupFolder,
      });
      return;
    }

    const extractedFacts = this.extractor.extractFacts({
      prompt: input.prompt,
      result: input.result,
      userId: input.userId,
    });
    const writableFacts = extractedFacts
      .filter((fact) => fact.confidence >= MEMORY_REFLECTION_MIN_CONFIDENCE)
      .slice(0, MEMORY_REFLECTION_MAX_FACTS_PER_TURN);

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
      await this.saveMemory(
        {
          scope: fact.scope,
          group_folder: input.groupFolder,
          user_id: fact.user_id,
          key: fact.key,
          value: fact.value,
          kind: fact.kind,
          confidence: fact.confidence,
          source: 'reflection',
        },
        { isMain: input.isMain, groupFolder: input.groupFolder },
        factEmbeddings[i] || null,
      );
      savedFacts += 1;
    }

    const procedure = extractProcedure(input.result);
    if (procedure) {
      this.saveProcedure(
        {
          scope: 'group',
          group_folder: input.groupFolder,
          title: procedure.title,
          body: procedure.body,
          tags: ['reflection', 'learned'],
          confidence: procedure.confidence,
          source: 'reflection',
        },
        { isMain: input.isMain, groupFolder: input.groupFolder },
      );
    }

    let usedRetrievedItemIds: string[] = [];
    let decayedUnusedCount = 0;
    if (MEMORY_USAGE_FEEDBACK_ENABLED) {
      const retrievedIds = dedupeStringIds(input.retrievedItemIds || []);
      if (retrievedIds.length > 0) {
        usedRetrievedItemIds = this.findUsedRetrievedItemIds(
          input.result,
          retrievedIds,
        );
        if (usedRetrievedItemIds.length > 0) {
          this.store.bumpConfidence(
            usedRetrievedItemIds,
            MEMORY_CONFIDENCE_BOOST_ON_USE,
          );
        }
      }

      const turns = this.store.countReflectionsSinceLastUsageDecay(
        input.groupFolder,
      );
      if (turns >= MEMORY_USAGE_DECAY_INTERVAL_TURNS) {
        decayedUnusedCount = this.store.decayUnusedConfidence(
          input.groupFolder,
          MEMORY_CONFIDENCE_DECAY_ON_UNUSED,
        );
        this.store.recordUsageDecayRun(input.groupFolder);
      }
    }

    this.store.applyRetentionPolicies(input.groupFolder);

    let consolidation: ConsolidationResult | null = null;
    if (MEMORY_CONSOLIDATION_ENABLED) {
      consolidation = await this.consolidateGroupMemory(input.groupFolder);
    }

    this.store.recordEvent(
      'reflection_completed',
      'reflection',
      input.groupFolder,
      {
        group_folder: input.groupFolder,
        facts_extracted: extractedFacts.length,
        facts_saved: savedFacts,
        procedure_saved: Boolean(procedure),
        retrieved_item_ids: input.retrievedItemIds || [],
        used_retrieved_item_ids: usedRetrievedItemIds,
        unused_decay_count: decayedUnusedCount,
        consolidation,
      },
    );
  }

  private pinIfNeeded(id: string, confidence: number): void {
    if (confidence >= MEMORY_RETENTION_PIN_THRESHOLD) {
      this.store.pinItem(id, true);
    }
  }

  private findUsedRetrievedItemIds(
    outputText: string,
    retrievedItemIds: string[],
  ): string[] {
    const normalizedOutput = normalizeForMatch(outputText);
    if (!normalizedOutput) return [];

    const used: string[] = [];
    for (const id of retrievedItemIds) {
      const item = this.store.getItemById(id);
      if (!item) continue;
      const value = normalizeForMatch(item.value);
      if (value.length >= 12 && normalizedOutput.includes(value)) {
        used.push(id);
        continue;
      }
      const keyTokens = normalizeForMatch(item.key)
        .split(' ')
        .filter((token) => token.length >= 3);
      if (keyTokens.length >= 2) {
        const matched = keyTokens.filter((token) =>
          normalizedOutput.includes(token),
        ).length;
        if (matched >= Math.ceil(keyTokens.length * 0.75)) {
          used.push(id);
        }
      }
    }
    return dedupeStringIds(used);
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

function summarizeLine(value: string): string {
  return truncate(value.replace(/\s+/g, ' ').trim(), 180);
}

function appendMemoryItems(
  lines: string[],
  title: string,
  items: MemoryItem[],
): void {
  if (items.length === 0) return;
  lines.push(`${title}:`);
  for (const item of items) {
    lines.push(`- (${item.scope}) ${truncate(item.value, 180)}`);
  }
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

function formatSnippetSourceLabel(snippet: MemorySearchResult): string {
  const sourceName =
    path.basename(snippet.source_path || '').trim() || 'unknown';
  const createdDate = formatSnippetDate(snippet.created_at);
  return `${snippet.source_type}:${sourceName} ${createdDate}`;
}

function formatSnippetDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'unknown-date';
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isNoiseQuery(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return true;
  if (!/[a-z0-9]/.test(normalized)) return true;
  if (normalized.length <= 2) return true;

  return (
    /^(hi|hey|hello|yo|sup|gm|gn|ping|test)$/.test(normalized) ||
    /^(ok|okay|k|kk|cool|sure|noted|got it|thanks|thank you|thx|ty)$/.test(
      normalized,
    ) ||
    /^(good (morning|afternoon|evening|night))$/.test(normalized)
  );
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

function selectBriefItems(items: MemoryItem[], limit: number): MemoryItem[] {
  const kindPriority: Record<string, number> = {
    correction: 0,
    preference: 1,
    decision: 2,
    constraint: 3,
    fact: 4,
    context: 5,
    recent_work: 6,
  };
  return [...items]
    .sort((a, b) => {
      const priorityDiff =
        (kindPriority[a.kind] ?? 99) - (kindPriority[b.kind] ?? 99);
      if (priorityDiff !== 0) return priorityDiff;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    })
    .slice(0, limit);
}

function dedupeStringIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function extractProcedure(
  result: string,
): { title: string; body: string; confidence: number } | null {
  if (containsSensitiveMaterial(result)) return null;

  const lines = result
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isChatterLine(line));

  const stepCount = lines.filter((line) => /^\d+\.|^-\s+/.test(line)).length;
  if (stepCount < 3) return null;

  const titleLine =
    lines.find((line) => line.length > 10) || 'Learned workflow';
  return {
    title: truncate(titleLine.replace(/^#+\s*/, ''), 80),
    body: truncate(lines.join('\n'), 1200),
    confidence: 0.74,
  };
}

function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashPrompt(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function isChatterLine(line: string): boolean {
  return /^(thanks|thank you|ok|okay|cool|great|awesome|sounds good|got it|sure|hello|hi)[.!]*$/i.test(
    line,
  );
}

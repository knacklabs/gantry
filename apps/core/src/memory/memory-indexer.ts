import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  MEMORY_CHUNK_OVERLAP,
  MEMORY_CHUNK_SIZE,
  MEMORY_SEMANTIC_DEDUP_ENABLED,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import type { EmbeddingProvider } from './memory-embeddings.js';
import { MemoryStore } from './memory-store.js';
import {
  MEMORY_GLOBAL_GROUP_FOLDER,
  type MemoryItem,
  type MemoryScope,
} from './memory-types.js';
import { classifySensitiveMemoryMaterial } from './sensitive-material.js';

export interface IndexerFileRecord {
  path: string;
  source: string;
  mtimeMs: number;
  sizeBytes: number;
  contentHash: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
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

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function parseFrontmatterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) return [];
    return body
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return trimmed.replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(text: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: null, body: normalized };
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    return { frontmatter: null, body: normalized };
  }
  const rawFrontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const frontmatter: Record<string, unknown> = {};
  for (const line of rawFrontmatter.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    frontmatter[key] = parseFrontmatterValue(value);
  }
  return { frontmatter, body };
}

function extractSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(
    `^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\s*$)`,
    'im',
  );
  const match = markdown.match(sectionRegex);
  if (!match) return '';
  return match[1]!.trim();
}

function normalizeScope(value: unknown): MemoryScope {
  if (value === 'global' || value === 'group' || value === 'user') {
    return value;
  }
  return 'group';
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export class MemoryIndexer {
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly sourceWriteGenerations = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly store: MemoryStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  walk(): Generator<string> {
    const root = path.resolve(this.root);
    if (!fs.existsSync(root)) return (function* emptyGenerator() {})();
    return this.walkFrom(root);
  }

  reindexStaleFiles(): { scanned: number; reindexed: number } {
    const indexedRows = this.store.listIndexedFiles();
    const indexedChunkRows = this.store.listIndexedChunkFiles();
    const indexedByPath = new Map(
      indexedRows.map((row) => [path.resolve(row.file_path), row]),
    );
    const indexedChunksByPath = new Map<
      string,
      { source_type: string; source_id: string; indexed_at: string | null }[]
    >();
    for (const row of indexedChunkRows) {
      const resolvedPath = path.resolve(row.source_path);
      const existing = indexedChunksByPath.get(resolvedPath) || [];
      existing.push({
        source_type: row.source_type,
        source_id: row.source_id,
        indexed_at: row.indexed_at,
      });
      indexedChunksByPath.set(resolvedPath, existing);
    }

    let scanned = 0;
    let reindexed = 0;
    const seen = new Set<string>();
    for (const filePath of this.walk()) {
      scanned += 1;
      const resolved = path.resolve(filePath);
      seen.add(resolved);
      const stat = safeStat(resolved);
      if (!stat) continue;
      const indexed = indexedByPath.get(resolved);
      const indexedAtMs = indexed?.indexed_at
        ? Date.parse(indexed.indexed_at)
        : Number.NaN;
      const chunkIndexedRows = indexedChunksByPath.get(resolved) || [];
      const chunkIndexedAtMs = chunkIndexedRows.reduce((latest, row) => {
        const parsed = row.indexed_at ? Date.parse(row.indexed_at) : Number.NaN;
        if (!Number.isFinite(parsed)) return latest;
        return Math.max(latest, parsed);
      }, Number.NaN);
      if (
        (indexed &&
          Number.isFinite(indexedAtMs) &&
          indexedAtMs >= stat.mtimeMs) ||
        (chunkIndexedRows.length > 0 &&
          Number.isFinite(chunkIndexedAtMs) &&
          chunkIndexedAtMs >= stat.mtimeMs)
      ) {
        continue;
      }
      this.indexFile(resolved);
      reindexed += 1;
    }

    for (const row of indexedRows) {
      const resolved = path.resolve(row.file_path);
      if (!resolved || seen.has(resolved)) continue;
      const current = this.store.getItemById(row.id);
      if (current?.file_path) {
        const currentResolved = path.resolve(current.file_path);
        if (currentResolved !== resolved) {
          continue;
        }
      }
      this.removeFile(resolved);
    }

    for (const row of indexedChunkRows) {
      const resolved = path.resolve(row.source_path);
      if (!resolved || seen.has(resolved)) continue;
      this.invalidateSourceWrite(row.source_type, resolved);
      this.store.deleteSourceChunks(row.source_type, row.source_id);
    }

    return { scanned, reindexed };
  }

  async reindexStaleFilesAndWait(): Promise<{
    scanned: number;
    reindexed: number;
  }> {
    const result = this.reindexStaleFiles();
    if (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
    return result;
  }

  indexFile(absPath: string): void {
    const resolvedPath = path.resolve(absPath);
    const source = this.deriveSource(resolvedPath);
    if (!source) return;

    let text = '';
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) return;
      text = fs.readFileSync(resolvedPath, 'utf-8');
    } catch {
      return;
    }

    const { frontmatter, body } = parseFrontmatter(text);
    const contentHash = hashContent(text);
    const frontmatterId =
      typeof frontmatter?.id === 'string' && frontmatter.id.trim()
        ? frontmatter.id.trim()
        : null;
    const indexedById = frontmatterId
      ? this.store.getItemByIdAny(frontmatterId)
      : null;
    if (indexedById?.is_deleted) {
      return;
    }
    const indexedByPath = this.store.getItemByFilePathAny(resolvedPath);
    if (!indexedById && indexedByPath?.is_deleted) {
      return;
    }
    const indexed = indexedById || indexedByPath;
    if (indexed?.content_hash && indexed.content_hash === contentHash) {
      if (
        indexed.id &&
        indexed.file_path &&
        path.resolve(indexed.file_path) !== resolvedPath &&
        !indexed.is_deleted
      ) {
        this.store.setItemFileMetadata({
          itemId: indexed.id,
          source_folder: source,
          file_path: resolvedPath,
          content_hash: contentHash,
          indexed_at: new Date(stat.mtimeMs).toISOString(),
        });
      }
      return;
    }

    const record: IndexerFileRecord = {
      path: resolvedPath,
      source,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      contentHash,
      frontmatter,
      body,
    };

    if (source === 'items') {
      this.indexItemFile(record, indexed || null);
      return;
    }

    if (source === 'procedures') {
      this.indexProcedureChunks(record);
      return;
    }

    this.indexSourceChunks(record);
  }

  removeFile(absPath: string): void {
    const resolvedPath = path.resolve(absPath);
    const item = this.store.getItemByFilePath(resolvedPath);
    if (item) {
      this.store.softDeleteItem(item.id);
    }
  }

  private *walkFrom(root: string): Generator<string> {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        yield* this.walkFrom(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      yield fullPath;
    }
  }

  private deriveSource(absPath: string): string | null {
    const relative = path.relative(path.resolve(this.root), absPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    const [source] = relative.split(path.sep);
    if (!source || source.startsWith('.')) return null;
    return source;
  }

  private indexItemFile(
    record: IndexerFileRecord,
    existing: MemoryItem | null,
  ): void {
    const fm = record.frontmatter || {};
    const value = extractSection(record.body, 'Value') || record.body.trim();
    const why = extractSection(record.body, 'Why') || undefined;
    const groupFolder =
      typeof fm.group_folder === 'string' && fm.group_folder.trim()
        ? fm.group_folder.trim()
        : '_global';
    const source =
      typeof fm.source === 'string' && fm.source.trim()
        ? fm.source.trim()
        : record.source;
    const actor =
      record.source === 'daily' || record.source === 'knowledge'
        ? 'user-edit'
        : 'indexer';

    const sensitiveValueReason = classifySensitiveMemoryMaterial(value);
    const sensitiveWhyReason = why
      ? classifySensitiveMemoryMaterial(why)
      : null;
    if (sensitiveValueReason || sensitiveWhyReason) {
      this.store.recordEvent(
        'sensitive_material_filtered',
        'memory_indexer',
        groupFolder,
        {
          actor: 'indexer:sensitive-block',
          source: record.source,
          file_path: record.path,
          field: sensitiveValueReason ? 'value' : 'why',
          reason: sensitiveValueReason || sensitiveWhyReason,
        },
      );
      if (existing) {
        this.patchIndexedItemWithRetry(existing.id, {
          blocked_reason: 'sensitive',
          embedding_pending: true,
          content_hash: record.contentHash,
          indexed_at: new Date(record.mtimeMs).toISOString(),
          source_folder: record.source,
          file_path: record.path,
        });
      }
      return;
    }

    const base = {
      key:
        typeof fm.key === 'string' && fm.key.trim()
          ? fm.key.trim()
          : path.basename(record.path, '.md'),
      value,
      why,
      load_bearing: parseBoolean(fm.load_bearing, false),
      source_turn_id:
        typeof fm.source_turn_id === 'string' ? fm.source_turn_id : undefined,
      kind:
        typeof fm.kind === 'string' && fm.kind.trim()
          ? (fm.kind.trim() as any)
          : ('fact' as const),
      source,
      confidence: Number.isFinite(Number(fm.confidence))
        ? Math.max(0, Math.min(1, Number(fm.confidence)))
        : 0.7,
      source_folder: record.source,
      file_path: record.path,
      content_hash: record.contentHash,
      indexed_at: new Date(record.mtimeMs).toISOString(),
      embedding_pending: false,
      blocked_reason: null,
    };

    let item = existing;
    if (item) {
      const patched = this.patchIndexedItemWithRetry(item.id, base);
      if (!patched) return;
      item = patched;
    } else {
      item = this.store.saveItem({
        id:
          typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : undefined,
        scope: normalizeScope(fm.scope),
        group_folder: groupFolder,
        user_id: typeof fm.user_id === 'string' ? fm.user_id : null,
        ...base,
        is_pinned: parseBoolean(fm.pinned, false),
      });
    }

    if (!MEMORY_SEMANTIC_DEDUP_ENABLED || !this.embeddings.isEnabled()) {
      this.store.markItemEmbeddingPending(item.id, null);
      return;
    }

    try {
      const task = Promise.resolve(
        this.embeddings.embedOne(`${item.key}: ${item.value}`),
      )
        .then((vector) => {
          this.store.saveItemEmbedding(item.id, vector);
        })
        .catch((err) => {
          logger.warn(
            { err, itemId: item.id },
            'memory_indexer_embedding_failed',
          );
          this.store.markItemEmbeddingPending(item.id, null);
        });
      this.trackPendingWrite(task);
    } catch (err) {
      logger.warn({ err, itemId: item.id }, 'memory_indexer_embedding_failed');
      this.store.markItemEmbeddingPending(item.id, null);
    }

    void actor;
  }

  private indexProcedureChunks(record: IndexerFileRecord): void {
    const procedureId =
      typeof record.frontmatter?.id === 'string'
        ? record.frontmatter.id.trim()
        : '';
    if (procedureId) {
      const activeProcedure = this.store.getProcedureById(procedureId);
      if (!activeProcedure) {
        this.store.deleteSourceChunks(record.source, record.path);
        return;
      }
    }
    this.indexSourceChunks(record);
  }

  private patchIndexedItemWithRetry(
    id: string,
    patch: Parameters<MemoryStore['patchItem']>[2],
  ): MemoryItem | null {
    const initial = this.store.getItemByIdAny(id);
    if (!initial || initial.is_deleted) {
      return null;
    }
    try {
      return this.store.patchItem(id, initial.version, patch);
    } catch (err) {
      if (!isStalePatchError(err)) throw err;
      const refreshed = this.store.getItemByIdAny(id);
      if (!refreshed || refreshed.is_deleted) return null;
      return this.store.patchItem(id, refreshed.version, patch);
    }
  }

  private indexSourceChunks(record: IndexerFileRecord): void {
    const sourceWriteKey = this.buildSourceWriteKey(record.source, record.path);
    const writeGeneration = this.bumpSourceWriteGeneration(sourceWriteKey);
    this.store.deleteSourceChunks(record.source, record.path);
    const scope =
      record.source === 'knowledge'
        ? ('global' as const)
        : normalizeScope(record.frontmatter?.scope);
    const groupFolder =
      scope === 'global'
        ? MEMORY_GLOBAL_GROUP_FOLDER
        : (record.frontmatter?.group_folder as string | undefined) || '_global';
    const chunks = chunkText(
      record.body,
      MEMORY_CHUNK_SIZE,
      MEMORY_CHUNK_OVERLAP,
    )
      .map((text) => text.trim())
      .filter((text) => text.length > 20)
      .map((text) => ({
        source_type: record.source,
        source_id: record.path,
        source_path: record.path,
        scope,
        group_folder: groupFolder,
        kind: record.source,
        text,
        importance_weight: 1,
        embedding: null as number[] | null,
      }));

    if (chunks.length === 0) return;

    if (!this.embeddings.isEnabled()) {
      if (this.canApplySourceWrite(sourceWriteKey, writeGeneration, record)) {
        this.store.saveChunks(chunks);
      }
      return;
    }

    const task = this.embeddings
      .embedMany(chunks.map((chunk) => chunk.text))
      .then((vectors) => {
        if (vectors.length !== chunks.length) {
          throw new Error(
            `embedding provider returned ${vectors.length} vectors for ${chunks.length} chunks`,
          );
        }
        chunks.forEach((chunk, index) => {
          chunk.embedding = vectors[index] || null;
        });
        if (
          !this.canApplySourceWrite(sourceWriteKey, writeGeneration, record)
        ) {
          return;
        }
        this.store.saveChunks(chunks);
      })
      .catch((err) => {
        logger.warn(
          { err, path: record.path, source: record.source },
          'memory_indexer_chunk_embedding_failed',
        );
        if (
          !this.canApplySourceWrite(sourceWriteKey, writeGeneration, record)
        ) {
          return;
        }
        this.store.saveChunks(chunks);
      });
    this.trackPendingWrite(task);
  }

  private trackPendingWrite(task: Promise<void>): void {
    this.pendingWrites.add(task);
    task.finally(() => {
      this.pendingWrites.delete(task);
    });
  }

  private buildSourceWriteKey(sourceType: string, sourcePath: string): string {
    return `${sourceType}\u0000${path.resolve(sourcePath)}`;
  }

  private bumpSourceWriteGeneration(sourceWriteKey: string): number {
    const next = (this.sourceWriteGenerations.get(sourceWriteKey) || 0) + 1;
    this.sourceWriteGenerations.set(sourceWriteKey, next);
    return next;
  }

  private invalidateSourceWrite(sourceType: string, sourcePath: string): void {
    this.bumpSourceWriteGeneration(
      this.buildSourceWriteKey(sourceType, sourcePath),
    );
  }

  private canApplySourceWrite(
    sourceWriteKey: string,
    writeGeneration: number,
    record: IndexerFileRecord,
  ): boolean {
    if (this.sourceWriteGenerations.get(sourceWriteKey) !== writeGeneration) {
      return false;
    }
    return isSourceRecordCurrent(record);
  }
}

function safeStat(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

function isStalePatchError(err: unknown): boolean {
  return err instanceof Error && /stale patch/i.test(err.message);
}

function isSourceRecordCurrent(record: IndexerFileRecord): boolean {
  if (!safeStat(record.path)) return false;
  try {
    const currentText = fs.readFileSync(record.path, 'utf-8');
    return hashContent(currentText) === record.contentHash;
  } catch {
    return false;
  }
}

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

import {
  MEMORY_CHUNK_RETENTION_DAYS,
  MEMORY_ITEM_MAX_PER_GROUP,
  MEMORY_MAX_CHUNKS_PER_GROUP,
  MEMORY_MAX_EVENTS,
  MEMORY_MAX_GLOBAL_CHUNKS,
  MEMORY_MAX_PROCEDURES_PER_GROUP,
  MEMORY_RETENTION_PIN_THRESHOLD,
  MEMORY_SQLITE_PATH,
  MEMORY_VECTOR_DIMENSIONS,
} from '../core/config.js';
import {
  MemoryChunk,
  MEMORY_GLOBAL_GROUP_FOLDER,
  MemoryItem,
  MemoryProcedure,
  MemoryScope,
  MemorySearchResult,
  SimilarMemoryItemMatch,
} from './memory-types.js';

export interface ChunkInsert {
  source_type: string;
  source_id: string;
  source_path: string;
  scope: MemoryScope;
  group_folder: string;
  kind: string;
  text: string;
  importance_weight?: number;
  embedding: number[] | null;
}

export class MemoryStore {
  private static readonly SCHEMA_VERSION = 3;
  private static readonly PRAGMA_TABLE_ALLOWLIST = new Set([
    'memory_items',
    'memory_chunks',
    'memory_procedures',
    'memory_events',
    'embedding_cache',
  ]);
  private readonly db: Database.Database;

  constructor(dbPath = MEMORY_SQLITE_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.initializeSchema();
    this.initializeVectorBackend();
  }

  close(): void {
    this.db.close();
  }

  runHealthChecks(): void {
    this.db.prepare('SELECT 1').get();

    const requiredObjects = [
      'memory_items',
      'memory_procedures',
      'memory_chunks',
      'memory_chunks_fts',
      'memory_chunk_vector_map',
      'memory_chunks_vec',
      'memory_item_vector_map',
      'memory_items_vec',
      'memory_events',
      'embedding_cache',
    ];
    for (const objectName of requiredObjects) {
      const exists = this.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1`)
        .get(objectName) as { 1?: number } | undefined;
      if (!exists) {
        throw new Error(
          `memory storage health check failed: missing SQLite object "${objectName}"`,
        );
      }
    }
  }

  private initializeSchema(): void {
    const currentVersion = this.getSchemaVersion();
    if (currentVersion > MemoryStore.SCHEMA_VERSION) {
      throw new Error(
        `memory schema version ${currentVersion} is newer than supported version ${MemoryStore.SCHEMA_VERSION}`,
      );
    }

    this.createSchema();

    if (currentVersion === 0) {
      this.setSchemaVersion(MemoryStore.SCHEMA_VERSION);
      return;
    }

    if (currentVersion < 2) {
      this.migrateToV2();
      this.setSchemaVersion(2);
    }
    if (currentVersion < 3) {
      this.migrateToV3();
      this.setSchemaVersion(3);
    }
  }

  private getSchemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private setSchemaVersion(version: number): void {
    const normalized = Math.max(0, Math.trunc(version));
    this.db.pragma(`user_version = ${normalized}`);
  }

  private columnExists(tableName: string, columnName: string): boolean {
    if (!MemoryStore.PRAGMA_TABLE_ALLOWLIST.has(tableName)) {
      throw new Error(`Unsafe table name for PRAGMA table_info: ${tableName}`);
    }
    const rows = this.db
      .prepare(`PRAGMA table_info("${tableName}")`)
      .all() as Array<Record<string, unknown>>;
    return rows.some((row) => String(row.name) === columnName);
  }

  private migrateToV2(): void {
    if (!this.columnExists('memory_items', 'is_pinned')) {
      this.db.exec(
        `ALTER TABLE memory_items ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!this.columnExists('memory_items', 'embedding_json')) {
      this.db.exec(`ALTER TABLE memory_items ADD COLUMN embedding_json TEXT`);
    }
    if (!this.columnExists('memory_items', 'retrieval_count')) {
      this.db.exec(
        `ALTER TABLE memory_items ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!this.columnExists('memory_items', 'last_retrieved_at')) {
      this.db.exec(
        `ALTER TABLE memory_items ADD COLUMN last_retrieved_at TEXT`,
      );
    }
    if (!this.columnExists('memory_chunks', 'importance_weight')) {
      this.db.exec(
        `ALTER TABLE memory_chunks ADD COLUMN importance_weight REAL NOT NULL DEFAULT 1.0`,
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_item_vector_map (
        item_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL UNIQUE
      );
    `);
  }

  private migrateToV3(): void {
    if (!this.columnExists('memory_items', 'total_score')) {
      this.db.exec(
        `ALTER TABLE memory_items ADD COLUMN total_score REAL NOT NULL DEFAULT 0`,
      );
    }
    if (!this.columnExists('memory_items', 'max_score')) {
      this.db.exec(
        `ALTER TABLE memory_items ADD COLUMN max_score REAL NOT NULL DEFAULT 0`,
      );
    }
    if (!this.columnExists('memory_items', 'query_hashes_json')) {
      this.db.exec(
        `ALTER TABLE memory_items ADD COLUMN query_hashes_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }
    if (!this.columnExists('memory_items', 'recall_days_json')) {
      this.db.exec(
        `ALTER TABLE memory_items ADD COLUMN recall_days_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        text_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (text_hash, model)
      );
    `);
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        user_id TEXT,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        last_retrieved_at TEXT,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        total_score REAL NOT NULL DEFAULT 0,
        max_score REAL NOT NULL DEFAULT 0,
        query_hashes_json TEXT NOT NULL DEFAULT '[]',
        recall_days_json TEXT NOT NULL DEFAULT '[]',
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memory_items_scope_group ON memory_items(scope, group_folder, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_procedures (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        version INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memory_procedures_scope_group ON memory_procedures(scope, group_folder, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        kind TEXT NOT NULL,
        chunk_hash TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        importance_weight REAL NOT NULL DEFAULT 1.0,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_scope_group ON memory_chunks(scope, group_folder, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source_type, source_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS memory_chunk_vector_map (
        chunk_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS memory_item_vector_map (
        item_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_events_type_time ON memory_events(event_type, created_at DESC);

      CREATE TABLE IF NOT EXISTS embedding_cache (
        text_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (text_hash, model)
      );
    `);
  }

  private initializeVectorBackend(): void {
    try {
      loadSqliteVec(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(
          embedding float[${MEMORY_VECTOR_DIMENSIONS}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_vec USING vec0(
          embedding float[${MEMORY_VECTOR_DIMENSIONS}]
        );
      `);
    } catch (err) {
      throw new Error(
        `sqlite-vec backend initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  static makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  static chunkHash(input: ChunkInsert): string {
    return crypto
      .createHash('sha256')
      .update(
        `${input.scope}:${input.group_folder}:${input.source_type}:${input.source_id}:${input.text}`,
      )
      .digest('hex');
  }

  saveItem(
    input: Pick<
      MemoryItem,
      | 'scope'
      | 'group_folder'
      | 'user_id'
      | 'kind'
      | 'key'
      | 'value'
      | 'source'
      | 'confidence'
    > & { is_pinned?: boolean },
  ): MemoryItem {
    const now = new Date().toISOString();
    const id = MemoryStore.makeId('mem');
    this.db
      .prepare(
        `INSERT INTO memory_items
        (id, scope, group_folder, user_id, kind, key, value, source, confidence, is_pinned, version, created_at, updated_at)
        VALUES (@id, @scope, @group_folder, @user_id, @kind, @key, @value, @source, @confidence, @is_pinned, 1, @created_at, @updated_at)`,
      )
      .run({
        ...input,
        id,
        is_pinned: input.is_pinned ? 1 : 0,
        created_at: now,
        updated_at: now,
      });

    return this.getItemById(id)!;
  }

  findItemByKey(input: {
    scope: MemoryScope;
    groupFolder: string;
    key: string;
    userId?: string | null;
  }): MemoryItem | null {
    let row: Record<string, unknown> | undefined;

    if (input.scope === 'global') {
      row = this.db
        .prepare(
          `SELECT * FROM memory_items
           WHERE is_deleted = 0
             AND scope = 'global'
             AND key = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(input.key) as Record<string, unknown> | undefined;
    } else if (input.scope === 'user') {
      if (!input.userId) return null;
      row = this.db
        .prepare(
          `SELECT * FROM memory_items
           WHERE is_deleted = 0
             AND scope = 'user'
             AND group_folder = ?
             AND user_id = ?
             AND key = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(input.groupFolder, input.userId, input.key) as
        | Record<string, unknown>
        | undefined;
    } else {
      row = this.db
        .prepare(
          `SELECT * FROM memory_items
           WHERE is_deleted = 0
             AND scope = 'group'
             AND group_folder = ?
             AND key = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(input.groupFolder, input.key) as
        | Record<string, unknown>
        | undefined;
    }

    return row ? this.toItem(row) : null;
  }

  getItemById(id: string): MemoryItem | null {
    const row = this.db
      .prepare(`SELECT * FROM memory_items WHERE id = ? AND is_deleted = 0`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toItem(row) : null;
  }

  patchItem(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<MemoryItem, 'key' | 'value' | 'confidence' | 'kind' | 'source'>
    >,
  ): MemoryItem {
    const current = this.getItemById(id);
    if (!current) throw new Error('memory item not found');
    if (current.version !== expectedVersion) {
      throw new Error(
        `stale patch: expected version ${expectedVersion}, current ${current.version}`,
      );
    }

    const next = {
      key: patch.key ?? current.key,
      value: patch.value ?? current.value,
      kind: patch.kind ?? current.kind,
      source: patch.source ?? current.source,
      confidence: patch.confidence ?? current.confidence,
      updated_at: new Date().toISOString(),
      version: current.version + 1,
      id,
    };

    this.db
      .prepare(
        `UPDATE memory_items
        SET key = @key, value = @value, kind = @kind, source = @source, confidence = @confidence, version = @version, updated_at = @updated_at
        WHERE id = @id`,
      )
      .run(next);

    return this.getItemById(id)!;
  }

  pinItem(id: string, pinned = true): void {
    this.db
      .prepare(
        `UPDATE memory_items SET is_pinned = ?, updated_at = ? WHERE id = ?`,
      )
      .run(pinned ? 1 : 0, new Date().toISOString(), id);
  }

  saveItemEmbedding(itemId: string, embedding: number[]): void {
    if (!Array.isArray(embedding) || embedding.length === 0) return;
    const now = new Date().toISOString();
    const serialized = JSON.stringify(embedding);
    const existing = this.db
      .prepare(`SELECT vec_rowid FROM memory_item_vector_map WHERE item_id = ?`)
      .get(itemId) as { vec_rowid?: number } | undefined;

    if (existing?.vec_rowid !== undefined) {
      this.db
        .prepare(`UPDATE memory_items_vec SET embedding = ? WHERE rowid = ?`)
        .run(serialized, existing.vec_rowid);
    } else {
      const vecInsert = this.db
        .prepare(`INSERT INTO memory_items_vec(embedding) VALUES (?)`)
        .run(serialized);
      this.db
        .prepare(
          `INSERT INTO memory_item_vector_map(item_id, vec_rowid) VALUES (?, ?)`,
        )
        .run(itemId, Number(vecInsert.lastInsertRowid));
    }

    this.db
      .prepare(
        `UPDATE memory_items
         SET embedding_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(serialized, now, itemId);
  }

  getCachedEmbedding(textHash: string, model: string): number[] | null {
    const row = this.db
      .prepare(
        `SELECT embedding_json
         FROM embedding_cache
         WHERE text_hash = ?
           AND model = ?
         LIMIT 1`,
      )
      .get(textHash, model) as { embedding_json?: string } | undefined;
    if (!row?.embedding_json) return null;
    try {
      const parsed = JSON.parse(row.embedding_json) as unknown;
      if (!Array.isArray(parsed)) return null;
      const embedding = parsed.map((value) => Number(value));
      if (embedding.some((value) => !Number.isFinite(value))) return null;
      return embedding;
    } catch {
      return null;
    }
  }

  putCachedEmbedding(
    textHash: string,
    model: string,
    embedding: number[],
  ): void {
    if (!Array.isArray(embedding) || embedding.length === 0) return;
    this.db
      .prepare(
        `INSERT INTO embedding_cache(text_hash, model, embedding_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(text_hash, model) DO UPDATE SET
           embedding_json = excluded.embedding_json,
           created_at = excluded.created_at`,
      )
      .run(
        textHash,
        model,
        JSON.stringify(embedding),
        new Date().toISOString(),
      );
  }

  findSimilarItems(input: {
    scope: MemoryScope;
    groupFolder: string;
    userId?: string | null;
    embedding: number[];
    limit?: number;
  }): SimilarMemoryItemMatch[] {
    const limit = Math.max(1, Math.min(50, input.limit ?? 5));
    const candidateLimit = Math.max(limit, Math.min(limit * 6, 250));
    const rows = this.db
      .prepare(
        `WITH nearest AS (
           SELECT rowid, distance
           FROM memory_items_vec
           WHERE embedding MATCH @embedding
             AND k = @candidate_limit
         )
         SELECT i.*, n.distance
         FROM nearest n
         JOIN memory_item_vector_map m ON m.vec_rowid = n.rowid
         JOIN memory_items i ON i.id = m.item_id
         WHERE i.is_deleted = 0
           AND i.scope = @scope
           AND (@scope = 'global' OR i.group_folder = @group_folder)
           AND (@scope != 'user' OR (@user_id IS NOT NULL AND i.user_id = @user_id))
         ORDER BY n.distance ASC
         LIMIT @limit`,
      )
      .all({
        embedding: JSON.stringify(input.embedding),
        candidate_limit: candidateLimit,
        scope: input.scope,
        group_folder: input.groupFolder,
        user_id: input.userId ?? null,
        limit,
      }) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const distance = Number(row.distance);
      const similarity = Number.isFinite(distance) ? 1 / (1 + distance) : 0;
      return { item: this.toItem(row), similarity };
    });
  }

  listActiveItems(groupFolder: string, limit = 5000): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE is_deleted = 0
           AND scope != 'global'
           AND group_folder = @group_folder
         ORDER BY confidence DESC, updated_at DESC
         LIMIT @limit`,
      )
      .all({
        group_folder: groupFolder,
        limit: Math.max(1, limit),
      }) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toItem(row));
  }

  softDeleteItem(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
    this.deleteItemVectorsByIds([id]);
  }

  incrementRetrievalCount(ids: string[]): void {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE memory_items
       SET retrieval_count = retrieval_count + 1,
           last_retrieved_at = ?
       WHERE id = ?
         AND is_deleted = 0`,
    );
    const txn = this.db.transaction((itemIds: string[]) => {
      for (const id of itemIds) {
        update.run(now, id);
      }
    });
    txn(unique);
  }

  recordRetrievalSignal(
    itemId: string,
    score: number,
    queryHash: string,
  ): void {
    if (!itemId) return;
    const row = this.db
      .prepare(
        `SELECT retrieval_count, total_score, max_score, query_hashes_json, recall_days_json
         FROM memory_items
         WHERE id = ?
           AND is_deleted = 0`,
      )
      .get(itemId) as
      | {
          retrieval_count?: number;
          total_score?: number;
          max_score?: number;
          query_hashes_json?: string;
          recall_days_json?: string;
        }
      | undefined;
    if (!row) return;

    const safeScore = Number.isFinite(score) && score > 0 ? score : 0;
    const queryHashes = this.parseStringArray(row.query_hashes_json);
    if (queryHash) {
      queryHashes.push(queryHash);
    }
    const uniqueQueryHashes = [...new Set(queryHashes)].slice(-50);

    const recallDays = this.parseStringArray(row.recall_days_json);
    recallDays.push(new Date().toISOString().slice(0, 10));
    const uniqueRecallDays = [...new Set(recallDays)].slice(-90);

    this.db
      .prepare(
        `UPDATE memory_items
         SET retrieval_count = retrieval_count + 1,
             last_retrieved_at = ?,
             total_score = total_score + ?,
             max_score = MAX(max_score, ?),
             query_hashes_json = ?,
             recall_days_json = ?
         WHERE id = ?
           AND is_deleted = 0`,
      )
      .run(
        new Date().toISOString(),
        safeScore,
        safeScore,
        JSON.stringify(uniqueQueryHashes),
        JSON.stringify(uniqueRecallDays),
        itemId,
      );
  }

  bumpConfidence(ids: string[], delta: number): void {
    if (Number.isNaN(delta)) return;
    if (delta <= 0) return;
    this.adjustConfidence(ids, delta);
  }

  adjustConfidence(ids: string[], delta: number): void {
    if (Number.isNaN(delta)) return;
    if (delta === 0) return;
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    const update = this.db.prepare(
      `UPDATE memory_items
         SET confidence = MIN(1.0, MAX(0.0, confidence + ?)),
           updated_at = ?
       WHERE id = ?
         AND is_deleted = 0`,
    );
    const now = new Date().toISOString();
    const txn = this.db.transaction((itemIds: string[]) => {
      for (const id of itemIds) {
        update.run(delta, now, id);
      }
    });
    txn(unique);
  }

  decayUnusedConfidence(groupFolder: string, delta: number): number {
    if (delta <= 0) return 0;
    const now = new Date().toISOString();

    const decayed = this.db
      .prepare(
        `UPDATE memory_items
         SET confidence = MIN(1.0, MAX(0.0, confidence - @delta)),
             updated_at = @updated_at
         WHERE is_deleted = 0
           AND is_pinned = 0
           AND retrieval_count = 0
           AND (scope = 'global' OR group_folder = @group_folder)`,
      )
      .run({
        delta,
        updated_at: now,
        group_folder: groupFolder,
      });

    return decayed.changes;
  }

  countReflectionsSinceLastUsageDecay(groupFolder: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(1) AS count
         FROM memory_events
         WHERE event_type = 'reflection_completed'
           AND entity_id = @group_folder
           AND id > COALESCE((
             SELECT MAX(id)
             FROM memory_events
             WHERE event_type = 'usage_decay_run'
               AND entity_id = @group_folder
           ), 0)`,
      )
      .get({ group_folder: groupFolder }) as { count?: number } | undefined;
    return Math.max(0, Number(row?.count || 0));
  }

  recordUsageDecayRun(groupFolder: string): void {
    this.recordEvent('usage_decay_run', 'memory_usage', groupFolder, {
      group_folder: groupFolder,
      created_at: new Date().toISOString(),
    });
  }

  listTopItems(
    scope: MemoryScope,
    groupFolder: string,
    limit: number,
    userId?: string,
  ): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE is_deleted = 0
         AND scope = @scope
         AND (scope = 'global' OR group_folder = @group_folder)
         AND (@scope != 'user' OR (@user_id IS NOT NULL AND user_id = @user_id))
         ORDER BY confidence DESC, COALESCE(last_used_at, updated_at) DESC
         LIMIT @limit`,
      )
      .all({
        scope,
        group_folder: groupFolder,
        user_id: userId || null,
        limit,
      }) as Record<string, unknown>[];
    return rows.map((row) => this.toItem(row));
  }

  chunkExists(input: ChunkInsert): boolean {
    const chunkHash = MemoryStore.chunkHash(input);
    const row = this.db
      .prepare(`SELECT 1 AS found FROM memory_chunks WHERE chunk_hash = ?`)
      .get(chunkHash) as { found?: number } | undefined;
    return row?.found === 1;
  }

  touchItem(id: string): void {
    this.db
      .prepare(`UPDATE memory_items SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  saveProcedure(
    input: Omit<
      MemoryProcedure,
      'id' | 'version' | 'created_at' | 'updated_at' | 'last_used_at'
    >,
  ): MemoryProcedure {
    const now = new Date().toISOString();
    const id = MemoryStore.makeId('proc');
    this.db
      .prepare(
        `INSERT INTO memory_procedures
        (id, scope, group_folder, title, body, tags_json, source, confidence, version, created_at, updated_at)
        VALUES (@id, @scope, @group_folder, @title, @body, @tags_json, @source, @confidence, 1, @created_at, @updated_at)`,
      )
      .run({
        id,
        scope: input.scope,
        group_folder: input.group_folder,
        title: input.title,
        body: input.body,
        tags_json: JSON.stringify(input.tags),
        source: input.source,
        confidence: input.confidence,
        created_at: now,
        updated_at: now,
      });

    return this.getProcedureById(id)!;
  }

  getProcedureById(id: string): MemoryProcedure | null {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_procedures WHERE id = ? AND is_deleted = 0`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toProcedure(row) : null;
  }

  patchProcedure(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<MemoryProcedure, 'title' | 'body' | 'tags' | 'confidence'>
    >,
  ): MemoryProcedure {
    const current = this.getProcedureById(id);
    if (!current) throw new Error('memory procedure not found');
    if (current.version !== expectedVersion) {
      throw new Error(
        `stale patch: expected version ${expectedVersion}, current ${current.version}`,
      );
    }

    const next = {
      id,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      tags_json: JSON.stringify(patch.tags ?? current.tags),
      confidence: patch.confidence ?? current.confidence,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE memory_procedures
         SET title = @title, body = @body, tags_json = @tags_json, confidence = @confidence, version = @version, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(next);

    return this.getProcedureById(id)!;
  }

  listTopProcedures(groupFolder: string, limit: number): MemoryProcedure[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_procedures
         WHERE is_deleted = 0
         AND (scope = 'global' OR (scope = 'group' AND group_folder = @group_folder))
         ORDER BY confidence DESC, COALESCE(last_used_at, updated_at) DESC
         LIMIT @limit`,
      )
      .all({ group_folder: groupFolder, limit }) as Record<string, unknown>[];
    return rows.map((row) => this.toProcedure(row));
  }

  saveChunks(chunks: ChunkInsert[]): number {
    const now = new Date().toISOString();
    const insertChunk = this.db.prepare(
      `INSERT OR IGNORE INTO memory_chunks
      (id, source_type, source_id, source_path, scope, group_folder, kind, chunk_hash, text, token_count, importance_weight, embedding_json, created_at, updated_at)
      VALUES (@id, @source_type, @source_id, @source_path, @scope, @group_folder, @kind, @chunk_hash, @text, @token_count, @importance_weight, @embedding_json, @created_at, @updated_at)`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memory_chunks_fts(id, text) VALUES (?, ?)`,
    );
    const insertVec = this.db.prepare(
      `INSERT INTO memory_chunks_vec(embedding) VALUES (?)`,
    );
    const insertVecMap = this.db.prepare(
      `INSERT INTO memory_chunk_vector_map(chunk_id, vec_rowid) VALUES (?, ?)`,
    );

    const txn = this.db.transaction((rows: ChunkInsert[]) => {
      let inserted = 0;
      for (const chunk of rows) {
        const chunkHash = MemoryStore.chunkHash(chunk);
        const id = MemoryStore.makeId('chunk');
        const tokenCount = Math.max(1, Math.ceil(chunk.text.length / 4));

        const result = insertChunk.run({
          id,
          source_type: chunk.source_type,
          source_id: chunk.source_id,
          source_path: chunk.source_path,
          scope: chunk.scope,
          group_folder: chunk.group_folder,
          kind: chunk.kind,
          chunk_hash: chunkHash,
          text: chunk.text,
          token_count: tokenCount,
          importance_weight: Math.max(0, chunk.importance_weight ?? 1),
          embedding_json: chunk.embedding
            ? JSON.stringify(chunk.embedding)
            : null,
          created_at: now,
          updated_at: now,
        });

        if (result.changes > 0) {
          insertFts.run(id, chunk.text);
          if (chunk.embedding) {
            const vecInsert = insertVec.run(JSON.stringify(chunk.embedding));
            insertVecMap.run(id, Number(vecInsert.lastInsertRowid));
          }
          inserted += 1;
        }
      }
      return inserted;
    });

    return txn(chunks);
  }

  lexicalSearch(
    query: string,
    groupFolder: string,
    limit: number,
  ): MemorySearchResult[] {
    const matchQuery = buildFtsMatchQuery(query);
    if (!matchQuery) return [];

    const rows = this.db
      .prepare(
        `SELECT c.id, c.source_type, c.source_path, c.text, c.scope, c.group_folder, c.created_at,
                bm25(memory_chunks_fts) AS lexical_score
         FROM memory_chunks_fts
         JOIN memory_chunks c ON c.id = memory_chunks_fts.id
         WHERE memory_chunks_fts MATCH @match_query
           AND (c.scope = 'global' OR c.group_folder = @group_folder)
         ORDER BY lexical_score ASC
         LIMIT @limit`,
      )
      .all({
        match_query: matchQuery,
        group_folder: groupFolder,
        limit,
      }) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      source_type: String(row.source_type),
      source_path: String(row.source_path),
      text: String(row.text),
      scope: row.scope as MemoryScope,
      group_folder: String(row.group_folder),
      created_at: String(row.created_at),
      lexical_score: Math.max(0, 1 / (1 + Number(row.lexical_score) || 1)),
      vector_score: 0,
      fused_score: 0,
    }));
  }

  vectorSearch(
    queryEmbedding: number[],
    groupFolder: string,
    limit: number,
  ): MemorySearchResult[] {
    const candidateLimit = Math.max(limit, Math.min(limit * 4, 200));

    const rows = this.db
      .prepare(
        `WITH nearest AS (
           SELECT rowid, distance
           FROM memory_chunks_vec
           WHERE embedding MATCH @embedding
             AND k = @candidate_limit
         )
         SELECT c.id, c.source_type, c.source_path, c.text, c.scope, c.group_folder, c.created_at, n.distance
         FROM nearest n
         JOIN memory_chunk_vector_map m ON m.vec_rowid = n.rowid
         JOIN memory_chunks c ON c.id = m.chunk_id
         WHERE c.id IS NOT NULL
           AND (c.scope = 'global' OR c.group_folder = @group_folder)
         ORDER BY n.distance ASC
         LIMIT @limit`,
      )
      .all({
        embedding: JSON.stringify(queryEmbedding),
        candidate_limit: candidateLimit,
        group_folder: groupFolder,
        limit,
      }) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const distance = Number(row.distance);
      const score = Number.isFinite(distance) ? 1 / (1 + distance) : 0;
      return {
        id: String(row.id),
        source_type: String(row.source_type),
        source_path: String(row.source_path),
        text: String(row.text),
        scope: row.scope as MemoryScope,
        group_folder: String(row.group_folder),
        created_at: String(row.created_at),
        lexical_score: 0,
        vector_score: score,
        fused_score: 0,
      };
    });
  }

  searchProceduresByText(
    query: string,
    groupFolder: string,
    limit: number,
  ): MemoryProcedure[] {
    const like = `%${query.replace(/[%_]/g, '')}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_procedures
         WHERE is_deleted = 0
           AND (scope = 'global' OR (scope = 'group' AND group_folder = @group_folder))
           AND (title LIKE @query OR body LIKE @query)
         ORDER BY confidence DESC, updated_at DESC
         LIMIT @limit`,
      )
      .all({ group_folder: groupFolder, query: like, limit }) as Record<
      string,
      unknown
    >[];

    return rows.map((row) => this.toProcedure(row));
  }

  listSourceChunks(sourceType: string, sourceId: string): MemoryChunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_chunks WHERE source_type = ? AND source_id = ?`,
      )
      .all(sourceType, sourceId) as Record<string, unknown>[];
    return rows.map((row) => this.toChunk(row));
  }

  applyRetentionPolicies(groupFolder: string): void {
    const maxChunksForScope =
      groupFolder === MEMORY_GLOBAL_GROUP_FOLDER
        ? MEMORY_MAX_GLOBAL_CHUNKS
        : MEMORY_MAX_CHUNKS_PER_GROUP;
    const cutoff = new Date(
      Date.now() - MEMORY_CHUNK_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const oldChunkIds = this.db
      .prepare(
        `SELECT id FROM memory_chunks
         WHERE group_folder = ?
           AND created_at < ?
         ORDER BY created_at ASC`,
      )
      .all(groupFolder, cutoff) as Array<{ id: string }>;

    if (oldChunkIds.length > 0) {
      this.deleteChunksByIds(oldChunkIds.map((row) => row.id));
    }

    const overflowChunks = this.db
      .prepare(
        `SELECT id FROM memory_chunks
         WHERE group_folder = ?
         ORDER BY importance_weight DESC, updated_at DESC
         LIMIT -1 OFFSET ?`,
      )
      .all(groupFolder, maxChunksForScope) as Array<{ id: string }>;

    if (overflowChunks.length > 0) {
      this.deleteChunksByIds(overflowChunks.map((row) => row.id));
    }

    const overflowItemIds = this.db
      .prepare(
        `SELECT id FROM memory_items
         WHERE is_deleted = 0
           AND group_folder = ?
           AND is_pinned = 0
         ORDER BY CASE WHEN confidence < ? THEN 0 ELSE 1 END ASC,
                  confidence ASC,
                  updated_at ASC
         LIMIT (
           SELECT MAX(0, COUNT(*) - ?)
           FROM memory_items
           WHERE is_deleted = 0
             AND group_folder = ?
         )`,
      )
      .all(
        groupFolder,
        MEMORY_RETENTION_PIN_THRESHOLD,
        MEMORY_ITEM_MAX_PER_GROUP,
        groupFolder,
      ) as Array<{ id: string }>;

    if (overflowItemIds.length > 0) {
      const now = new Date().toISOString();
      const markDeleted = this.db.prepare(
        `UPDATE memory_items
         SET is_deleted = 1, updated_at = ?
         WHERE id = ?`,
      );
      const txn = this.db.transaction((rows: Array<{ id: string }>) => {
        for (const row of rows) {
          markDeleted.run(now, row.id);
        }
      });
      txn(overflowItemIds);
      this.deleteItemVectorsByIds(overflowItemIds.map((row) => row.id));
    }

    const overflowProcedures = this.db
      .prepare(
        `SELECT id FROM memory_procedures
         WHERE is_deleted = 0
           AND group_folder = ?
         ORDER BY confidence DESC, COALESCE(last_used_at, updated_at) DESC
         LIMIT -1 OFFSET ?`,
      )
      .all(groupFolder, MEMORY_MAX_PROCEDURES_PER_GROUP) as Array<{
      id: string;
    }>;

    if (overflowProcedures.length > 0) {
      const markDeleted = this.db.prepare(
        `UPDATE memory_procedures SET is_deleted = 1 WHERE id = ?`,
      );
      for (const row of overflowProcedures) {
        markDeleted.run(row.id);
      }
    }

    this.db.exec(`
      DELETE FROM memory_events
      WHERE id NOT IN (
        SELECT id FROM memory_events
        ORDER BY id DESC
        LIMIT ${MEMORY_MAX_EVENTS}
      );
    `);
  }

  recordEvent(
    eventType: string,
    entityType: string,
    entityId: string | null,
    payload: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_events(event_type, entity_type, entity_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        eventType,
        entityType,
        entityId,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }

  private deleteChunksByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const deleteChunk = this.db.prepare(
      `DELETE FROM memory_chunks WHERE id = ?`,
    );
    const deleteFts = this.db.prepare(
      `DELETE FROM memory_chunks_fts WHERE id = ?`,
    );
    const findVecRow = this.db.prepare(
      `SELECT vec_rowid FROM memory_chunk_vector_map WHERE chunk_id = ?`,
    );
    const deleteVecMap = this.db.prepare(
      `DELETE FROM memory_chunk_vector_map WHERE chunk_id = ?`,
    );
    const deleteVec = this.db.prepare(
      `DELETE FROM memory_chunks_vec WHERE rowid = ?`,
    );

    const txn = this.db.transaction((chunkIds: string[]) => {
      for (const id of chunkIds) {
        const vecRow = findVecRow.get(id) as { vec_rowid?: number } | undefined;
        if (vecRow?.vec_rowid !== undefined) {
          deleteVec.run(vecRow.vec_rowid);
          deleteVecMap.run(id);
        }
        deleteFts.run(id);
        deleteChunk.run(id);
      }
    });

    txn(ids);
  }

  private deleteItemVectorsByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const findVecRow = this.db.prepare(
      `SELECT vec_rowid FROM memory_item_vector_map WHERE item_id = ?`,
    );
    const deleteVecMap = this.db.prepare(
      `DELETE FROM memory_item_vector_map WHERE item_id = ?`,
    );
    const deleteVec = this.db.prepare(
      `DELETE FROM memory_items_vec WHERE rowid = ?`,
    );

    const txn = this.db.transaction((itemIds: string[]) => {
      for (const id of itemIds) {
        const vecRow = findVecRow.get(id) as { vec_rowid?: number } | undefined;
        if (vecRow?.vec_rowid !== undefined) {
          deleteVec.run(vecRow.vec_rowid);
          deleteVecMap.run(id);
        }
      }
    });

    txn(ids);
  }

  private toItem(row: Record<string, unknown>): MemoryItem {
    return {
      id: String(row.id),
      scope: row.scope as MemoryScope,
      group_folder: String(row.group_folder),
      user_id: row.user_id ? String(row.user_id) : null,
      kind: row.kind as MemoryItem['kind'],
      key: String(row.key),
      value: String(row.value),
      source: String(row.source),
      confidence: Number(row.confidence),
      is_pinned: Number(row.is_pinned || 0) === 1,
      version: Number(row.version),
      last_used_at: row.last_used_at ? String(row.last_used_at) : null,
      last_retrieved_at: row.last_retrieved_at
        ? String(row.last_retrieved_at)
        : null,
      retrieval_count: Number(row.retrieval_count || 0),
      total_score: Number(row.total_score || 0),
      max_score: Number(row.max_score || 0),
      query_hashes_json: String(row.query_hashes_json || '[]'),
      recall_days_json: String(row.recall_days_json || '[]'),
      embedding_json: row.embedding_json ? String(row.embedding_json) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private parseStringArray(value: unknown): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(String(value)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private toProcedure(row: Record<string, unknown>): MemoryProcedure {
    return {
      id: String(row.id),
      scope: row.scope as MemoryScope,
      group_folder: String(row.group_folder),
      title: String(row.title),
      body: String(row.body),
      tags: JSON.parse(String(row.tags_json || '[]')) as string[],
      source: String(row.source),
      confidence: Number(row.confidence),
      version: Number(row.version),
      last_used_at: row.last_used_at ? String(row.last_used_at) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private toChunk(row: Record<string, unknown>): MemoryChunk {
    return {
      id: String(row.id),
      source_type: String(row.source_type),
      source_id: String(row.source_id),
      source_path: String(row.source_path),
      scope: row.scope as MemoryScope,
      group_folder: String(row.group_folder),
      kind: String(row.kind),
      chunk_hash: String(row.chunk_hash),
      text: String(row.text),
      token_count: Number(row.token_count),
      importance_weight: Number(row.importance_weight || 1),
      embedding_json: row.embedding_json ? String(row.embedding_json) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }
}

function buildFtsMatchQuery(input: string): string | null {
  const tokens = input.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

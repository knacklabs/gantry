import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import * as p from '@clack/prompts';
import Database from 'better-sqlite3';

import { logger } from '../core/logger.js';
import { MemoryStore } from '../memory/memory-store.js';
import { JournalRecord, JournalRecordKind } from '../memory/memory-journal.js';
import {
  MemoryItem,
  MemoryProcedure,
  MemoryScope,
} from '../memory/memory-types.js';

interface ReplayOptions {
  from: string;
  to: string;
  since?: number;
  dryRun: boolean;
  overwrite: boolean;
  compareWith?: string;
}

interface ReplayStats {
  filesProcessed: number;
  linesRead: number;
  recordsApplied: number;
  duplicateEvents: number;
  invalidLines: number;
  skippedBySince: number;
  skippedByConflict: number;
}

function usage(): string {
  return [
    'Usage:',
    '  myclaw memory-replay --from=<journal-dir> --to=<target.db> [--since=YYYY-MM-DD] [--dry-run] [--overwrite] [--compare-with=<live.db>]',
  ].join('\n');
}

function parseArgs(argv: string[]): ReplayOptions | null {
  let from: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  let overwrite = false;
  let since: number | undefined;
  let compareWith: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--overwrite') {
      overwrite = true;
      continue;
    }

    const fromRaw =
      arg === '--from'
        ? argv[index + 1]
        : arg.startsWith('--from=')
          ? arg.slice('--from='.length)
          : undefined;
    if (fromRaw !== undefined) {
      if (arg === '--from') index += 1;
      from = fromRaw.trim();
      continue;
    }

    const toRaw =
      arg === '--to'
        ? argv[index + 1]
        : arg.startsWith('--to=')
          ? arg.slice('--to='.length)
          : undefined;
    if (toRaw !== undefined) {
      if (arg === '--to') index += 1;
      to = toRaw.trim();
      continue;
    }

    const sinceRaw =
      arg === '--since'
        ? argv[index + 1]
        : arg.startsWith('--since=')
          ? arg.slice('--since='.length)
          : undefined;
    if (sinceRaw !== undefined) {
      if (arg === '--since') index += 1;
      const parsed = Date.parse(sinceRaw.trim());
      if (!Number.isFinite(parsed)) {
        return null;
      }
      since = parsed;
      continue;
    }

    const compareWithRaw =
      arg === '--compare-with'
        ? argv[index + 1]
        : arg.startsWith('--compare-with=')
          ? arg.slice('--compare-with='.length)
          : undefined;
    if (compareWithRaw !== undefined) {
      if (arg === '--compare-with') index += 1;
      compareWith = compareWithRaw.trim();
    }
  }

  if (!from || !to) return null;
  return {
    from: path.resolve(from),
    to: path.resolve(to),
    ...(since !== undefined ? { since } : {}),
    dryRun,
    overwrite,
    ...(compareWith ? { compareWith: path.resolve(compareWith) } : {}),
  };
}

function listJournalFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (
        entry.isFile() &&
        /^events-\d{4}-\d{2}\.jsonl(?:\.gz)?$/.test(entry.name)
      ) {
        files.push(fullPath);
      }
    }
  }

  files.sort((a, b) => {
    const fileA = path.basename(a);
    const fileB = path.basename(b);
    if (fileA === fileB) return a.localeCompare(b);
    return fileA.localeCompare(fileB);
  });
  return files;
}

function readJournalLines(filePath: string): string[] {
  const raw = filePath.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf-8')
    : fs.readFileSync(filePath, 'utf-8');
  return raw.split('\n');
}

function parseJournalRecord(
  rawLine: string,
  filePath: string,
  lineNumber: number,
): JournalRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Partial<JournalRecord> & {
    payload?: unknown;
  };
  if (typeof candidate.event_id !== 'string' || !candidate.event_id.trim()) {
    return null;
  }
  if (
    typeof candidate.ts !== 'string' ||
    !Number.isFinite(Date.parse(candidate.ts))
  ) {
    return null;
  }
  if (
    typeof candidate.group_folder !== 'string' ||
    !candidate.group_folder.trim()
  ) {
    return null;
  }
  if (typeof candidate.actor !== 'string' || !candidate.actor.trim()) {
    return null;
  }
  if (!isKnownKind(candidate.kind)) {
    return null;
  }
  if (
    !candidate.payload ||
    typeof candidate.payload !== 'object' ||
    Array.isArray(candidate.payload)
  ) {
    return null;
  }

  return {
    event_id: candidate.event_id,
    ts: candidate.ts,
    kind: candidate.kind,
    group_folder: candidate.group_folder,
    ...(candidate.scope ? { scope: candidate.scope } : {}),
    actor: candidate.actor,
    payload: candidate.payload as Record<string, unknown>,
  };
}

function isKnownKind(kind: unknown): kind is JournalRecordKind {
  return (
    kind === 'memory.item.saved' ||
    kind === 'memory.item.patched' ||
    kind === 'memory.item.superseded' ||
    kind === 'memory.item.pinned' ||
    kind === 'memory.procedure.saved' ||
    kind === 'memory.procedure.patched' ||
    kind === 'memory.procedure.deleted' ||
    kind === 'reflection.completed' ||
    kind === 'retention.applied'
  );
}

function asPayloadObject(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

function shouldApplySnapshot(
  currentVersion: number,
  _currentUpdatedAt: string,
  incomingVersion: number,
  _incomingUpdatedAt?: string,
): boolean {
  return incomingVersion > currentVersion;
}

function parseScope(value: unknown): MemoryScope {
  if (value === 'global' || value === 'group' || value === 'user') {
    return value;
  }
  return 'group';
}

function parseItemPayload(
  payload: Record<string, unknown>,
  fallbackGroup: string,
): MemoryItem | null {
  if (
    typeof payload.id !== 'string' ||
    typeof payload.key !== 'string' ||
    typeof payload.value !== 'string'
  ) {
    return null;
  }
  const scope = parseScope(payload.scope);
  const kindRaw = String(payload.kind || 'fact');
  const kind: MemoryItem['kind'] =
    kindRaw === 'preference' ||
    kindRaw === 'decision' ||
    kindRaw === 'correction' ||
    kindRaw === 'constraint' ||
    kindRaw === 'project_fact' ||
    kindRaw === 'reference'
      ? kindRaw
      : 'fact';
  const confidence = Number(payload.confidence);
  if (!Number.isFinite(confidence)) return null;
  return {
    id: payload.id,
    scope,
    group_folder:
      typeof payload.group_folder === 'string' && payload.group_folder.trim()
        ? payload.group_folder
        : fallbackGroup,
    user_id: typeof payload.user_id === 'string' ? payload.user_id : null,
    kind,
    key: payload.key,
    value: payload.value,
    why: typeof payload.why === 'string' ? payload.why : undefined,
    load_bearing: Boolean(payload.load_bearing),
    source_turn_id:
      typeof payload.source_turn_id === 'string'
        ? payload.source_turn_id
        : null,
    source: typeof payload.source === 'string' ? payload.source : 'replay',
    source_folder:
      typeof payload.source_folder === 'string' ? payload.source_folder : '',
    file_path: '',
    content_hash:
      typeof payload.content_hash === 'string' ? payload.content_hash : '',
    indexed_at:
      typeof payload.indexed_at === 'string' ? payload.indexed_at : null,
    embedding_pending: Boolean(payload.embedding_pending),
    blocked_reason:
      typeof payload.blocked_reason === 'string'
        ? payload.blocked_reason
        : null,
    confidence,
    is_pinned: Boolean(payload.is_pinned),
    used_count: Number(payload.used_count || 0),
    superseded_by:
      typeof payload.superseded_by === 'string' ? payload.superseded_by : null,
    is_deleted: Boolean(payload.is_deleted),
    deleted_at:
      typeof payload.deleted_at === 'string' ? payload.deleted_at : null,
    last_reviewed_at:
      typeof payload.last_reviewed_at === 'string'
        ? payload.last_reviewed_at
        : null,
    version: Math.max(1, Number(payload.version || 1)),
    last_used_at:
      typeof payload.last_used_at === 'string' ? payload.last_used_at : null,
    last_retrieved_at:
      typeof payload.last_retrieved_at === 'string'
        ? payload.last_retrieved_at
        : null,
    retrieval_count: Number(payload.retrieval_count || 0),
    total_score: Number(payload.total_score || 0),
    max_score: Number(payload.max_score || 0),
    query_hashes_json:
      typeof payload.query_hashes_json === 'string'
        ? payload.query_hashes_json
        : '[]',
    recall_days_json:
      typeof payload.recall_days_json === 'string'
        ? payload.recall_days_json
        : '[]',
    embedding_json:
      typeof payload.embedding_json === 'string'
        ? payload.embedding_json
        : null,
    created_at:
      typeof payload.created_at === 'string'
        ? payload.created_at
        : new Date().toISOString(),
    updated_at:
      typeof payload.updated_at === 'string'
        ? payload.updated_at
        : new Date().toISOString(),
  };
}

function parseProcedurePayload(
  payload: Record<string, unknown>,
  fallbackGroup: string,
): MemoryProcedure | null {
  if (
    typeof payload.id !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.body !== 'string'
  ) {
    return null;
  }
  const confidence = Number(payload.confidence);
  if (!Number.isFinite(confidence)) return null;
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    id: payload.id,
    scope: parseScope(payload.scope),
    group_folder:
      typeof payload.group_folder === 'string' && payload.group_folder.trim()
        ? payload.group_folder
        : fallbackGroup,
    title: payload.title,
    body: payload.body,
    tags,
    origin:
      payload.origin === 'accepted_suggestion'
        ? 'accepted_suggestion'
        : 'explicit',
    trigger: typeof payload.trigger === 'string' ? payload.trigger : null,
    source: typeof payload.source === 'string' ? payload.source : 'replay',
    confidence,
    is_deleted: Boolean(payload.is_deleted),
    deleted_at:
      typeof payload.deleted_at === 'string' ? payload.deleted_at : null,
    version: Math.max(1, Number(payload.version || 1)),
    last_used_at:
      typeof payload.last_used_at === 'string' ? payload.last_used_at : null,
    created_at:
      typeof payload.created_at === 'string'
        ? payload.created_at
        : new Date().toISOString(),
    updated_at:
      typeof payload.updated_at === 'string'
        ? payload.updated_at
        : new Date().toISOString(),
  };
}

export async function runMemoryReplayCommand(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options || !fs.existsSync(options.from)) {
    p.log.error(usage());
    return 1;
  }
  if (options.compareWith && !fs.existsSync(options.compareWith)) {
    p.log.error(`Live DB not found for --compare-with: ${options.compareWith}`);
    return 1;
  }

  const files = listJournalFiles(options.from);
  const stats: ReplayStats = {
    filesProcessed: files.length,
    linesRead: 0,
    recordsApplied: 0,
    duplicateEvents: 0,
    invalidLines: 0,
    skippedBySince: 0,
    skippedByConflict: 0,
  };
  const seenEventIds = new Set<string>();

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(options.to), { recursive: true });
    if (fs.existsSync(options.to) && !options.overwrite) {
      p.log.error(
        `Target DB exists: ${options.to}. Pass --overwrite to replace it, or choose a different --to path.`,
      );
      return 1;
    }
    if (options.overwrite) {
      fs.rmSync(options.to, { force: true });
    }
  }
  const store = options.dryRun ? null : new MemoryStore(options.to);
  const itemIdMap = new Map<string, string>();
  const procedureIdMap = new Map<string, string>();

  try {
    for (const filePath of files) {
      const lines = readJournalLines(filePath);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim();
        if (!line) continue;
        stats.linesRead += 1;
        const record = parseJournalRecord(line, filePath, index + 1);
        if (!record) {
          stats.invalidLines += 1;
          logger.warn(
            {
              filePath,
              lineNumber: index + 1,
            },
            'Skipping invalid journal record line during replay',
          );
          continue;
        }
        if (
          options.since !== undefined &&
          Date.parse(record.ts) < options.since
        ) {
          stats.skippedBySince += 1;
          continue;
        }
        if (seenEventIds.has(record.event_id)) {
          stats.duplicateEvents += 1;
          continue;
        }
        seenEventIds.add(record.event_id);
        if (options.dryRun || !store) {
          stats.recordsApplied += 1;
          continue;
        }

        const applied = applyRecord({
          record,
          store,
          itemIdMap,
          procedureIdMap,
        });
        if (applied) {
          stats.recordsApplied += 1;
        } else {
          stats.skippedByConflict += 1;
        }
      }
    }
  } finally {
    store?.close();
  }

  let output = [
    `files_processed=${stats.filesProcessed}`,
    `lines_read=${stats.linesRead}`,
    `records_applied=${stats.recordsApplied}`,
    `duplicates=${stats.duplicateEvents}`,
    `invalid_lines=${stats.invalidLines}`,
    `skipped_since=${stats.skippedBySince}`,
    `skipped_conflict=${stats.skippedByConflict}`,
  ];

  if (!options.dryRun) {
    const db = new Database(options.to, { readonly: true });
    try {
      const itemCount = Number(
        (
          db
            .prepare(
              `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0`,
            )
            .get() as { count?: number }
        ).count || 0,
      );
      const procedureCount = Number(
        (
          db
            .prepare(
              `SELECT COUNT(1) AS count FROM memory_procedures WHERE is_deleted = 0`,
            )
            .get() as { count?: number }
        ).count || 0,
      );
      output = output.concat([
        `target_db=${options.to}`,
        `items_active=${itemCount}`,
        `procedures_active=${procedureCount}`,
      ]);

      const integrityRow = db.prepare('PRAGMA integrity_check').get() as
        | { integrity_check?: string }
        | undefined;
      const integrity = String(integrityRow?.integrity_check || '').trim();
      if (integrity.toLowerCase() !== 'ok') {
        p.log.error(
          `Replay integrity check failed for ${options.to}: ${integrity || 'unknown error'}`,
        );
        return 1;
      }
      output.push(`integrity_check=${integrity}`);
    } finally {
      db.close();
    }

    if (options.compareWith) {
      const replayDb = new Database(options.to, { readonly: true });
      const liveDb = new Database(options.compareWith, { readonly: true });
      try {
        const replayItems = Number(
          (
            replayDb
              .prepare(
                `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0`,
              )
              .get() as { count?: number }
          ).count || 0,
        );
        const liveItems = Number(
          (
            liveDb
              .prepare(
                `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0`,
              )
              .get() as { count?: number }
          ).count || 0,
        );
        const replayProcedures = Number(
          (
            replayDb
              .prepare(
                `SELECT COUNT(1) AS count FROM memory_procedures WHERE is_deleted = 0`,
              )
              .get() as { count?: number }
          ).count || 0,
        );
        const liveProcedures = Number(
          (
            liveDb
              .prepare(
                `SELECT COUNT(1) AS count FROM memory_procedures WHERE is_deleted = 0`,
              )
              .get() as { count?: number }
          ).count || 0,
        );
        const replayPinned = Number(
          (
            replayDb
              .prepare(
                `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0 AND is_pinned = 1`,
              )
              .get() as { count?: number }
          ).count || 0,
        );
        const livePinned = Number(
          (
            liveDb
              .prepare(
                `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0 AND is_pinned = 1`,
              )
              .get() as { count?: number }
          ).count || 0,
        );
        output = output.concat([
          `compare_with=${options.compareWith}`,
          `compare_items_live=${liveItems}`,
          `compare_items_replayed=${replayItems}`,
          `compare_items_diff=${liveItems - replayItems}`,
          `compare_procedures_live=${liveProcedures}`,
          `compare_procedures_replayed=${replayProcedures}`,
          `compare_procedures_diff=${liveProcedures - replayProcedures}`,
          `compare_pinned_live=${livePinned}`,
          `compare_pinned_replayed=${replayPinned}`,
          `compare_pinned_diff=${livePinned - replayPinned}`,
        ]);
      } finally {
        replayDb.close();
        liveDb.close();
      }
    }
  }

  p.note(
    output.join('\n'),
    options.dryRun ? 'Memory Replay (Dry Run)' : 'Memory Replay',
  );
  return 0;
}

function applyRecord(args: {
  record: JournalRecord;
  store: MemoryStore;
  itemIdMap: Map<string, string>;
  procedureIdMap: Map<string, string>;
}): boolean {
  const { record, store, itemIdMap, procedureIdMap } = args;
  const payload = asPayloadObject(record.payload);
  if (!payload) return false;

  if (
    record.kind === 'memory.item.saved' ||
    record.kind === 'memory.item.patched'
  ) {
    const snapshot = parseItemPayload(payload, record.group_folder);
    if (!snapshot) return false;
    const mappedId = itemIdMap.get(snapshot.id) || snapshot.id;
    const existingById = store.getItemById(mappedId);
    const existing =
      existingById ||
      store.findItemByKey({
        scope: snapshot.scope,
        groupFolder: snapshot.group_folder,
        key: snapshot.key,
        userId: snapshot.user_id,
      });
    if (!existing) {
      const saved = store.saveItem({
        id: snapshot.id,
        scope: snapshot.scope,
        group_folder: snapshot.group_folder,
        user_id: snapshot.user_id,
        kind: snapshot.kind,
        key: snapshot.key,
        value: snapshot.value,
        why: snapshot.why,
        load_bearing: snapshot.load_bearing,
        source_turn_id: snapshot.source_turn_id || undefined,
        source: snapshot.source,
        source_folder: snapshot.source_folder,
        content_hash: snapshot.content_hash,
        indexed_at: snapshot.indexed_at || undefined,
        embedding_pending: snapshot.embedding_pending,
        blocked_reason: snapshot.blocked_reason,
        confidence: snapshot.confidence,
        is_pinned: snapshot.is_pinned,
        used_count: snapshot.used_count,
        superseded_by: snapshot.superseded_by,
        version: snapshot.version,
        last_used_at: snapshot.last_used_at,
        last_retrieved_at: snapshot.last_retrieved_at,
        retrieval_count: snapshot.retrieval_count,
        total_score: snapshot.total_score,
        max_score: snapshot.max_score,
        query_hashes_json: snapshot.query_hashes_json,
        recall_days_json: snapshot.recall_days_json,
        embedding_json: snapshot.embedding_json,
        created_at: snapshot.created_at,
        updated_at: snapshot.updated_at,
        is_deleted: snapshot.is_deleted,
        deleted_at: snapshot.deleted_at,
        last_reviewed_at: snapshot.last_reviewed_at,
      });
      if (snapshot.is_pinned) {
        store.pinItem(saved.id, true);
      }
      if (snapshot.is_deleted) {
        const mappedSupersededBy = snapshot.superseded_by
          ? (itemIdMap.get(snapshot.superseded_by) ?? snapshot.superseded_by)
          : null;
        store.softDeleteItem(saved.id, mappedSupersededBy);
      }
      itemIdMap.set(snapshot.id, saved.id);
      return true;
    }

    itemIdMap.set(snapshot.id, existing.id);
    if (
      !shouldApplySnapshot(
        existing.version,
        existing.updated_at,
        snapshot.version,
        snapshot.updated_at,
      )
    ) {
      return false;
    }
    const patched = store.patchItem(existing.id, existing.version, {
      key: snapshot.key,
      value: snapshot.value,
      why: snapshot.why,
      load_bearing: snapshot.load_bearing,
      source_turn_id: snapshot.source_turn_id || undefined,
      kind: snapshot.kind,
      source: snapshot.source,
      source_folder: snapshot.source_folder,
      content_hash: snapshot.content_hash,
      indexed_at: snapshot.indexed_at || undefined,
      embedding_pending: snapshot.embedding_pending,
      blocked_reason: snapshot.blocked_reason,
      confidence: snapshot.confidence,
      superseded_by: snapshot.superseded_by
        ? (itemIdMap.get(snapshot.superseded_by) ?? snapshot.superseded_by)
        : null,
    });
    if (snapshot.is_pinned) {
      store.pinItem(patched.id, true);
    }
    if (snapshot.is_deleted) {
      const mappedSupersededBy = snapshot.superseded_by
        ? (itemIdMap.get(snapshot.superseded_by) ?? snapshot.superseded_by)
        : null;
      store.softDeleteItem(patched.id, mappedSupersededBy);
    }
    return true;
  }

  if (record.kind === 'memory.item.superseded') {
    const id = typeof payload.id === 'string' ? payload.id : undefined;
    if (!id) return false;
    const supersededByRaw =
      typeof payload.superseded_by === 'string' ? payload.superseded_by : null;
    const targetId = itemIdMap.get(id) || id;
    const supersededBy = supersededByRaw
      ? (itemIdMap.get(supersededByRaw) ?? supersededByRaw)
      : null;
    store.softDeleteItem(targetId, supersededBy);
    return true;
  }

  if (record.kind === 'memory.item.pinned') {
    const id = typeof payload.id === 'string' ? payload.id : undefined;
    if (!id) return false;
    const pinned = payload.pinned !== false;
    const targetId = itemIdMap.get(id) || id;
    store.pinItem(targetId, pinned);
    return true;
  }

  if (
    record.kind === 'memory.procedure.saved' ||
    record.kind === 'memory.procedure.patched'
  ) {
    const snapshot = parseProcedurePayload(payload, record.group_folder);
    if (!snapshot) return false;
    const mappedId = procedureIdMap.get(snapshot.id) || snapshot.id;
    const existing = store.getProcedureById(mappedId);
    if (!existing) {
      const saved = store.saveProcedure({
        id: snapshot.id,
        scope: snapshot.scope,
        group_folder: snapshot.group_folder,
        title: snapshot.title,
        body: snapshot.body,
        tags: snapshot.tags,
        origin: snapshot.origin,
        trigger: snapshot.trigger || undefined,
        source: snapshot.source,
        confidence: snapshot.confidence,
        version: snapshot.version,
        last_used_at: snapshot.last_used_at,
        created_at: snapshot.created_at,
        updated_at: snapshot.updated_at,
        is_deleted: snapshot.is_deleted,
        deleted_at: snapshot.deleted_at,
      });
      procedureIdMap.set(snapshot.id, saved.id);
      if (snapshot.is_deleted) {
        store.softDeleteProcedure(saved.id);
      }
      return true;
    }
    procedureIdMap.set(snapshot.id, existing.id);
    if (
      !shouldApplySnapshot(
        existing.version,
        existing.updated_at,
        snapshot.version,
        snapshot.updated_at,
      )
    ) {
      return false;
    }
    const patched = store.patchProcedure(existing.id, existing.version, {
      title: snapshot.title,
      body: snapshot.body,
      tags: snapshot.tags,
      trigger: snapshot.trigger,
      confidence: snapshot.confidence,
    });
    if (snapshot.is_deleted) {
      store.softDeleteProcedure(patched.id);
    }
    return true;
  }

  if (record.kind === 'memory.procedure.deleted') {
    const id = typeof payload.id === 'string' ? payload.id : undefined;
    if (!id) return false;
    const targetId = procedureIdMap.get(id) || id;
    store.softDeleteProcedure(targetId);
    return true;
  }

  if (record.kind === 'reflection.completed') {
    store.recordEvent(
      'reflection_completed',
      'reflection',
      record.group_folder,
      payload,
    );
    return true;
  }

  if (record.kind === 'retention.applied') {
    store.recordEvent(
      'retention_applied',
      'retention',
      record.group_folder,
      payload,
    );
    return true;
  }

  return false;
}

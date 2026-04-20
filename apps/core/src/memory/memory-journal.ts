import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { MEMORY_GLOBAL_GROUP_FOLDER, MemoryScope } from './memory-types.js';

export type JournalRecordKind =
  | 'memory.item.saved'
  | 'memory.item.patched'
  | 'memory.item.superseded'
  | 'memory.item.pinned'
  | 'memory.procedure.saved'
  | 'memory.procedure.patched'
  | 'memory.procedure.deleted'
  | 'reflection.completed'
  | 'retention.applied';

export interface JournalRecord {
  event_id: string;
  ts: string;
  kind: JournalRecordKind;
  group_folder: string;
  scope?: MemoryScope;
  actor: string;
  payload: unknown;
}

export type JournalAppendInput = Omit<JournalRecord, 'event_id' | 'ts'> & {
  event_id?: string;
  ts?: string;
};

function resolveDirectoryGroupFolder(groupFolder: string): string {
  const trimmed = groupFolder.trim();
  if (!trimmed || trimmed === MEMORY_GLOBAL_GROUP_FOLDER) return '_global';
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (sanitized === '.' || sanitized === '..') return '_';
  return sanitized || '_';
}

function isJournalDisabledByEnv(): boolean {
  const raw = process.env.MYCLAW_MEMORY_JOURNAL_DISABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export class MemoryJournal {
  private readonly rootDir: string;
  private readonly disabled: boolean;
  private readonly fdCache = new Map<
    string,
    { fd: number; filePath: string; yearMonth: string }
  >();

  constructor(rootDir: string, disabled = false) {
    this.rootDir = path.resolve(rootDir);
    this.disabled = disabled;
  }

  append(record: JournalAppendInput): JournalRecord | null {
    if (this.disabled || isJournalDisabledByEnv()) return null;

    const full: JournalRecord = {
      event_id: record.event_id || randomUUID(),
      ts: record.ts || new Date().toISOString(),
      kind: record.kind,
      group_folder: record.group_folder,
      ...(record.scope ? { scope: record.scope } : {}),
      actor: record.actor,
      payload: record.payload,
    };

    const groupKey = resolveDirectoryGroupFolder(full.group_folder);
    const yearMonth = full.ts.slice(0, 7);
    const filePath = this.resolveFilePath(groupKey, yearMonth);
    const line = `${JSON.stringify(full)}\n`;
    const fd = this.openAppendFd(groupKey, filePath, yearMonth);
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
    return full;
  }

  close(): void {
    for (const cached of this.fdCache.values()) {
      try {
        fs.closeSync(cached.fd);
      } catch {
        // Best-effort close.
      }
    }
    this.fdCache.clear();
  }

  private resolveFilePath(groupKey: string, yearMonth: string): string {
    const dir = path.resolve(this.rootDir, groupKey);
    const rel = path.relative(this.rootDir, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `[MyClaw] invalid journal group folder: ${JSON.stringify(groupKey)}`,
      );
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `events-${yearMonth}.jsonl`);
  }

  private openAppendFd(
    groupKey: string,
    filePath: string,
    yearMonth: string,
  ): number {
    const cached = this.fdCache.get(groupKey);
    if (cached) {
      if (cached.filePath === filePath && cached.yearMonth === yearMonth) {
        return cached.fd;
      }
      try {
        fs.closeSync(cached.fd);
      } catch {
        // Best-effort close for stale FD.
      }
      this.fdCache.delete(groupKey);
    }
    const fd = fs.openSync(filePath, 'a', 0o600);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort chmod for existing files.
    }
    this.fdCache.set(groupKey, { fd, filePath, yearMonth });
    return fd;
  }
}

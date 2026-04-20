import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import {
  MEMORY_CLEANUP_PURGE_DAYS,
  MEMORY_JOURNAL_DELETE_DAYS,
  MEMORY_JOURNAL_GZIP_DAYS,
} from '../core/config.js';
import { MemoryRootService } from './memory-root.js';

export interface MemoryCleanupResult {
  sweptMirrors: number;
  mirrorErrors: number;
  purgedItems: number;
  purgedProcedures: number;
  journalGzipped: number;
  journalDeleted: number;
  checkpointCreated: string | null;
  checkpointPruned: number;
}

const CLEANUP_CHILD_ARG = '--myclaw-memory-cleanup-child';
const CHECKPOINT_RETRY_DELAYS_MS = [250, 750, 1500] as const;

function buildChildExecArgv(modulePath: string): string[] {
  const filteredExecArgv = process.execArgv.filter(
    (arg) => !arg.startsWith('--inspect'),
  );
  const hasTsRuntime = filteredExecArgv.some(
    (arg, index) =>
      (arg === '--loader' || arg === '--import') &&
      String(filteredExecArgv[index + 1] || '').includes('tsx'),
  );
  if (modulePath.endsWith('.ts') && !hasTsRuntime) {
    return ['--import', 'tsx', ...filteredExecArgv];
  }
  return filteredExecArgv;
}

function gzipFile(filePath: string): void {
  const data = fs.readFileSync(filePath);
  fs.writeFileSync(`${filePath}.gz`, zlib.gzipSync(data));
  fs.rmSync(filePath, { force: true });
}

function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stack = [root];
  const out: string[] = [];
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
      if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function safeRealpathSync(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function resolvePathWithRealParent(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  let existingParent = path.dirname(resolved);
  while (!fs.existsSync(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) break;
    existingParent = parent;
  }
  const parentReal = safeRealpathSync(existingParent);
  if (!parentReal) return null;
  const tail = path.relative(existingParent, resolved);
  return path.resolve(parentReal, tail);
}

function isInsideRoot(root: string, candidatePath: string): boolean {
  const rootResolved = safeRealpathSync(root);
  const candidateResolved = resolvePathWithRealParent(candidatePath);
  if (!rootResolved || !candidateResolved) return false;
  const relative = path.relative(rootResolved, candidateResolved);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function isSafeManagedFileDelete(
  managedRoot: string,
  candidatePath: string,
): boolean {
  if (!isInsideRoot(managedRoot, candidatePath)) return false;
  try {
    const stat = fs.lstatSync(candidatePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      // Missing mirrors should not block DB purges for already-tombstoned rows.
      return true;
    }
    return false;
  }
}

function sanitizeSegment(input: string, fallback: string): string {
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function sleepSync(delayMs: number): void {
  if (delayMs <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const array = new Int32Array(buffer);
  Atomics.wait(array, 0, 0, delayMs);
}

function isSqliteBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return /SQLITE_BUSY|database is locked|database is busy/i.test(message);
}

function listProcedureMirrorCandidates(
  proceduresDir: string,
  procedureId: string,
  procedureTitle?: string | null,
): string[] {
  const candidates = new Set<string>();
  const slugId = sanitizeSegment(procedureId, 'procedure');
  if (procedureTitle && procedureTitle.trim()) {
    const slugTitle = sanitizeSegment(procedureTitle, 'procedure');
    candidates.add(path.join(proceduresDir, `${slugTitle}-${slugId}.md`));
  }
  if (fs.existsSync(proceduresDir)) {
    const suffix = `-${slugId}.md`;
    for (const entry of fs.readdirSync(proceduresDir, {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(suffix)) continue;
      candidates.add(path.join(proceduresDir, entry.name));
    }
  }
  return [...candidates];
}

function createDailyCheckpoint(
  db: Database.Database,
  journalDir: string,
): {
  checkpointCreated: string | null;
  checkpointPruned: number;
} {
  const checkpointsDir = path.join(journalDir, 'checkpoints');
  fs.mkdirSync(checkpointsDir, { recursive: true, mode: 0o700 });
  const iso = new Date().toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso
    .slice(11, 19)
    .replace(/:/g, '')}`;
  const checkpointPath = path.join(checkpointsDir, `memory-${stamp}.db`);
  db.pragma('busy_timeout = 5000');
  let vacuumErr: unknown = null;
  for (
    let attempt = 0;
    attempt <= CHECKPOINT_RETRY_DELAYS_MS.length;
    attempt++
  ) {
    try {
      db.exec(`VACUUM INTO ${sqlQuote(checkpointPath)}`);
      vacuumErr = null;
      break;
    } catch (err) {
      vacuumErr = err;
      if (
        !isSqliteBusyError(err) ||
        attempt >= CHECKPOINT_RETRY_DELAYS_MS.length
      ) {
        break;
      }
      sleepSync(CHECKPOINT_RETRY_DELAYS_MS[attempt] || 0);
    }
  }
  if (vacuumErr) {
    throw vacuumErr;
  }
  try {
    fs.chmodSync(checkpointPath, 0o600);
  } catch {
    // Best-effort chmod.
  }

  const checkpointFiles = fs
    .readdirSync(checkpointsDir)
    .filter((entry) => /^memory-\d{8}-\d{6}\.db$/.test(entry))
    .sort((a, b) => b.localeCompare(a));
  let checkpointPruned = 0;
  for (const stale of checkpointFiles.slice(14)) {
    fs.rmSync(path.join(checkpointsDir, stale), { force: true });
    checkpointPruned += 1;
  }

  return {
    checkpointCreated: checkpointPath,
    checkpointPruned,
  };
}

export function runMemoryCleanupOnce(): MemoryCleanupResult {
  const memoryRoot = MemoryRootService.getInstance();
  const layout = memoryRoot.getLayout();
  const db = new Database(memoryRoot.getSqliteCachePath());

  let sweptMirrors = 0;
  let mirrorErrors = 0;
  let purgedItems = 0;
  let purgedProcedures = 0;
  let journalGzipped = 0;
  let journalDeleted = 0;
  let checkpointCreated: string | null = null;
  let checkpointPruned = 0;
  let checkpointError: string | null = null;

  try {
    const purgeItemRows = db
      .prepare(
        `SELECT id, file_path
         FROM memory_items
         WHERE is_deleted = 1
           AND deleted_at IS NOT NULL
           AND deleted_at < datetime('now', ?)`,
      )
      .all(`-${MEMORY_CLEANUP_PURGE_DAYS} days`) as Array<{
      id?: string;
      file_path?: string | null;
    }>;
    if (purgeItemRows.length > 0) {
      const purgeableRows: Array<{ id?: string; file_path?: string | null }> =
        [];
      for (const row of purgeItemRows) {
        const filePath = typeof row.file_path === 'string' ? row.file_path : '';
        if (!filePath) {
          purgeableRows.push(row);
          continue;
        }
        const resolved = path.resolve(filePath);
        if (!isSafeManagedFileDelete(layout.itemsDir, resolved)) {
          mirrorErrors += 1;
          continue;
        }
        try {
          fs.rmSync(resolved, { force: true });
          sweptMirrors += 1;
          purgeableRows.push(row);
        } catch {
          mirrorErrors += 1;
        }
      }

      const deleteUsageEvents = db.prepare(
        `DELETE FROM memory_usage_events WHERE item_id = ?`,
      );
      const deleteItem = db.prepare(`DELETE FROM memory_items WHERE id = ?`);
      const deleteItemVecMap = db.prepare(
        `DELETE FROM memory_item_vector_map WHERE item_id = ?`,
      );
      let selectItemVecRows: Database.Statement | null = null;
      let deleteItemVecRow: Database.Statement | null = null;
      try {
        selectItemVecRows = db.prepare(
          `SELECT vec_rowid FROM memory_item_vector_map WHERE item_id = ?`,
        );
        deleteItemVecRow = db.prepare(
          `DELETE FROM memory_items_vec WHERE rowid = ?`,
        );
      } catch {
        selectItemVecRows = null;
        deleteItemVecRow = null;
      }
      const txn = db.transaction((rows: Array<{ id?: string }>) => {
        for (const row of rows) {
          const id = typeof row.id === 'string' ? row.id : '';
          if (!id) continue;
          deleteUsageEvents.run(id);
          if (selectItemVecRows && deleteItemVecRow) {
            try {
              const vecRows = selectItemVecRows.all(id) as Array<{
                vec_rowid?: number;
              }>;
              for (const vecRow of vecRows) {
                if (typeof vecRow.vec_rowid === 'number') {
                  deleteItemVecRow.run(vecRow.vec_rowid);
                }
              }
            } catch {
              // If vector module/table isn't available in this process, still purge base rows.
            }
          }
          deleteItemVecMap.run(id);
          deleteItem.run(id);
        }
      });
      if (purgeableRows.length > 0) {
        txn(purgeableRows);
      }
      purgedItems = purgeableRows.length;
    }
    const purgeProcedureRows = db
      .prepare(
        `SELECT id, title
         FROM memory_procedures
         WHERE is_deleted = 1
           AND deleted_at IS NOT NULL
           AND deleted_at < datetime('now', ?)`,
      )
      .all(`-${MEMORY_CLEANUP_PURGE_DAYS} days`) as Array<{
      id?: string;
      title?: string | null;
    }>;
    if (purgeProcedureRows.length > 0) {
      const purgeableProcedureRows: Array<{ id?: string }> = [];
      for (const row of purgeProcedureRows) {
        const procedureId = typeof row.id === 'string' ? row.id.trim() : '';
        if (!procedureId) continue;
        const candidates = listProcedureMirrorCandidates(
          layout.proceduresDir,
          procedureId,
          typeof row.title === 'string' ? row.title : null,
        );
        let canPurgeRow = true;
        for (const candidatePath of candidates) {
          if (!isSafeManagedFileDelete(layout.proceduresDir, candidatePath)) {
            mirrorErrors += 1;
            canPurgeRow = false;
            continue;
          }
          try {
            fs.rmSync(candidatePath, { force: true });
            sweptMirrors += 1;
          } catch {
            mirrorErrors += 1;
            canPurgeRow = false;
          }
        }
        if (canPurgeRow) {
          purgeableProcedureRows.push(row);
        }
      }

      const deleteProcedure = db.prepare(
        `DELETE FROM memory_procedures WHERE id = ?`,
      );
      const txn = db.transaction((rows: Array<{ id?: string }>) => {
        for (const row of rows) {
          const id = typeof row.id === 'string' ? row.id.trim() : '';
          if (!id) continue;
          deleteProcedure.run(id);
        }
      });
      if (purgeableProcedureRows.length > 0) {
        txn(purgeableProcedureRows);
      }
      purgedProcedures = purgeableProcedureRows.length;
    }

    const nowMs = Date.now();
    for (const filePath of listFilesRecursive(layout.journalDir)) {
      const stat = fs.statSync(filePath);
      const ageDays = (nowMs - stat.mtimeMs) / 86_400_000;
      if (filePath.endsWith('.gz')) {
        if (ageDays >= MEMORY_JOURNAL_DELETE_DAYS) {
          fs.rmSync(filePath, { force: true });
          journalDeleted += 1;
        }
        continue;
      }
      if (filePath.endsWith('.jsonl') && ageDays >= MEMORY_JOURNAL_GZIP_DAYS) {
        gzipFile(filePath);
        journalGzipped += 1;
      }
    }

    try {
      const checkpoint = createDailyCheckpoint(db, layout.journalDir);
      checkpointCreated = checkpoint.checkpointCreated;
      checkpointPruned = checkpoint.checkpointPruned;
    } catch (err) {
      checkpointError = err instanceof Error ? err.message : String(err || err);
    }
  } finally {
    db.close();
  }

  memoryRoot.appendJournalEntry({
    title: 'cleanup_mirror_completed',
    lines: [`swept: ${sweptMirrors}`, `errors: ${mirrorErrors}`],
  });
  memoryRoot.appendJournalEntry({
    title: 'cleanup_purge_completed',
    lines: [`items: ${purgedItems}`, `procedures: ${purgedProcedures}`],
  });
  memoryRoot.appendJournalEntry({
    title: 'cleanup_journal_rotated',
    lines: [`gzipped: ${journalGzipped}`, `deleted: ${journalDeleted}`],
  });
  memoryRoot.appendJournalEntry({
    title: 'cleanup_checkpoint_completed',
    lines: [
      `path: ${checkpointCreated || ''}`,
      `pruned: ${checkpointPruned}`,
      `error: ${checkpointError || ''}`,
    ],
  });

  return {
    sweptMirrors,
    mirrorErrors,
    purgedItems,
    purgedProcedures,
    journalGzipped,
    journalDeleted,
    checkpointCreated,
    checkpointPruned,
  };
}

export async function runMemoryCleanupInSubprocess(
  timeoutMs = 300_000,
): Promise<MemoryCleanupResult> {
  const modulePath = fileURLToPath(import.meta.url);
  const childArgs = [
    ...buildChildExecArgv(modulePath),
    modulePath,
    CLEANUP_CHILD_ARG,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`cleanup subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `cleanup subprocess failed (code=${code}): ${stderr.trim() || 'unknown error'}`,
          ),
        );
        return;
      }
      const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        reject(new Error('cleanup subprocess returned empty output'));
        return;
      }
      try {
        resolve(JSON.parse(lastLine) as MemoryCleanupResult);
      } catch (err) {
        reject(
          new Error(
            `cleanup subprocess returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  });
}

if (process.argv.includes(CLEANUP_CHILD_ARG)) {
  try {
    const result = runMemoryCleanupOnce();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    const message =
      err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

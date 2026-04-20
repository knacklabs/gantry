import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { MemoryStore } from '../memory/memory-store.js';
import { OpenAIEmbeddingClient } from '../memory/memory-embeddings.js';
import type { RuntimeSettings } from './runtime-settings.js';
import { runMemoryReplayCommand } from './memory-replay.js';

export type HealthStatus = 'pass' | 'warn' | 'fail';
export type ConfigSource = 'settings.yaml' | 'default' | 'env' | 'derived';

export interface HealthCheckResult {
  status: HealthStatus;
  message: string;
  nextAction?: string;
}

export interface MemoryHealthInspection {
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  embeddingProvider: string;
  memoryRoot: string;
  sqlitePath: string;
  embeddingModel: string;
  memorySource: ConfigSource;
  memoryRootSource: ConfigSource;
  sqlitePathSource: ConfigSource;
  embeddingProviderSource: ConfigSource;
  embeddingModelSource: ConfigSource;
  dreamingSource: ConfigSource;
  memoryCheck: HealthCheckResult;
  embeddingCheck: HealthCheckResult;
  warnings: HealthCheckResult[];
}

export function resolveRuntimePath(
  runtimeHome: string,
  rawValue: string | undefined,
  fallbackRelativePath: string,
): string {
  const raw = rawValue?.trim();
  if (!raw) return path.resolve(runtimeHome, fallbackRelativePath);
  return path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(runtimeHome, raw);
}

function withMemoryStoreHealthCheck(sqlitePath: string): void {
  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(sqlitePath);
    store.runHealthChecks();
  } finally {
    try {
      store?.close();
    } catch {
      // best-effort close in health checks
    }
  }
}

function inspectMemoryStorage(
  memoryEnabled: boolean,
  memoryRoot: string,
  sqlitePath: string,
): HealthCheckResult {
  if (!memoryEnabled) {
    return {
      status: 'pass',
      message: 'Memory is disabled in settings.yaml.',
    };
  }

  try {
    fs.mkdirSync(memoryRoot, { recursive: true });
    fs.accessSync(memoryRoot, fs.constants.W_OK);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    withMemoryStoreHealthCheck(sqlitePath);
    return {
      status: 'pass',
      message: `Memory storage is healthy (${sqlitePath}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      message: `Memory storage health check failed at ${memoryRoot}.`,
      nextAction: `Repair memory.root or SQLite/vector configuration. Details: ${message}`,
    };
  }
}

function inspectEmbeddings(input: {
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  env: Record<string, string | undefined>;
}): HealthCheckResult {
  if (!input.memoryEnabled) {
    return {
      status: 'pass',
      message: 'Memory is disabled, so embeddings are not required.',
    };
  }

  if (!input.embeddingsEnabled) {
    return {
      status: 'pass',
      message:
        'Embeddings are optional and currently disabled in settings.yaml.',
    };
  }

  if (input.embeddingProvider !== 'openai') {
    return {
      status: 'fail',
      message: `Unknown embedding provider "${input.embeddingProvider}".`,
      nextAction:
        'Set memory.embeddings.provider in settings.yaml to openai or disable embeddings.',
    };
  }

  const apiKey = input.env.OPENAI_API_KEY?.trim() || '';
  if (!apiKey) {
    return {
      status: 'warn',
      message:
        'Embeddings are enabled with provider openai, but OPENAI_API_KEY is missing.',
      nextAction:
        'Set OPENAI_API_KEY in .env or run `myclaw memory embeddings off`. Memory still works without embeddings.',
    };
  }

  try {
    const client = new OpenAIEmbeddingClient(apiKey, input.embeddingModel);
    client.validateConfiguration();
    return {
      status: 'pass',
      message: `Embedding provider is ready (openai, model: ${input.embeddingModel}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      message: 'Embedding provider configuration is invalid.',
      nextAction: `Fix memory.embeddings.model/provider config. Details: ${message}`,
    };
  }
}

export function inspectMemoryHealth(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
  env: Record<string, string | undefined>,
): MemoryHealthInspection {
  const warnings: HealthCheckResult[] = [];
  const settingsMemory = settings?.memory;

  const memoryEnabled = settingsMemory?.enabled ?? true;
  const embeddingsEnabled = settingsMemory?.embeddings.enabled ?? false;
  const dreamingEnabled = settingsMemory?.dreaming.enabled ?? false;
  const embeddingProvider = settingsMemory
    ? settingsMemory.embeddings.enabled
      ? settingsMemory.embeddings.provider
      : 'disabled'
    : 'disabled';
  const embeddingModel =
    settingsMemory?.embeddings.model || 'text-embedding-3-large';

  const memoryRoot = resolveRuntimePath(
    runtimeHome,
    resolveMemoryRootOverride(settings, env),
    'memory',
  );
  const sqlitePath = path.join(memoryRoot, '.cache', 'memory.db');

  const memoryCheck = inspectMemoryStorage(
    memoryEnabled,
    memoryRoot,
    sqlitePath,
  );
  const embeddingCheck = inspectEmbeddings({
    memoryEnabled,
    embeddingsEnabled,
    embeddingProvider,
    embeddingModel,
    env,
  });

  return {
    memoryEnabled,
    embeddingsEnabled,
    dreamingEnabled,
    embeddingProvider,
    memoryRoot,
    sqlitePath,
    embeddingModel,
    memorySource: settingsMemory ? 'settings.yaml' : 'default',
    memoryRootSource: env.MEMORY_ROOT?.trim()
      ? 'env'
      : settingsMemory?.root
        ? 'settings.yaml'
        : 'default',
    sqlitePathSource: 'derived',
    embeddingProviderSource: settingsMemory ? 'settings.yaml' : 'default',
    embeddingModelSource: settingsMemory?.embeddings.model
      ? 'settings.yaml'
      : 'default',
    dreamingSource: settingsMemory ? 'settings.yaml' : 'default',
    memoryCheck,
    embeddingCheck,
    warnings,
  };
}

export interface MemoryJournalGroupStatus {
  groupFolder: string;
  fileCount: number;
  totalBytes: number;
  lastEventAt: string | null;
  stale: boolean;
  oversized: boolean;
}

export interface MemoryJournalStatusReport {
  journalRoot: string;
  groups: MemoryJournalGroupStatus[];
}

function resolveJournalRoot(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
  env: Record<string, string | undefined>,
): string {
  const memoryRoot = resolveRuntimePath(
    runtimeHome,
    resolveMemoryRootOverride(settings, env),
    'memory',
  );
  return path.join(memoryRoot, '.journal');
}

function resolveMemoryRootOverride(
  settings: RuntimeSettings | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const processValue = process.env.MEMORY_ROOT?.trim();
  if (processValue) return processValue;
  const envFileValue = env.MEMORY_ROOT?.trim();
  if (envFileValue) return envFileValue;
  return settings?.memory?.root;
}

function parseLatestEventTimestamp(filePath: string): number {
  try {
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      let parsed: { ts?: string } | null = null;
      try {
        parsed = JSON.parse(line) as { ts?: string };
      } catch {
        continue;
      }
      if (!parsed.ts) continue;
      const ts = Date.parse(parsed.ts);
      if (Number.isFinite(ts)) return ts;
    }
  } catch {
    // Fallback to mtime below.
  }
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function inspectMemoryJournalStatus(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
  env: Record<string, string | undefined>,
): MemoryJournalStatusReport {
  const journalRoot = resolveJournalRoot(runtimeHome, settings, env);
  if (!fs.existsSync(journalRoot)) {
    return {
      journalRoot,
      groups: [],
    };
  }

  const now = Date.now();
  const groups: MemoryJournalGroupStatus[] = [];
  const entries = fs.readdirSync(journalRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'checkpoints') continue;
    const groupFolder = entry.name;
    const groupDir = path.join(journalRoot, groupFolder);
    const files = fs
      .readdirSync(groupDir, { withFileTypes: true })
      .filter(
        (child) =>
          child.isFile() && /^events-\d{4}-\d{2}\.jsonl$/.test(child.name),
      )
      .map((child) => path.join(groupDir, child.name));
    if (files.length === 0) continue;
    let totalBytes = 0;
    let latestMs = 0;
    for (const filePath of files) {
      try {
        totalBytes += fs.statSync(filePath).size;
      } catch {
        // Ignore unreadable files.
      }
      latestMs = Math.max(latestMs, parseLatestEventTimestamp(filePath));
    }
    const stale = latestMs > 0 ? now - latestMs > 24 * 60 * 60 * 1000 : false;
    const oversized = totalBytes > 200 * 1024 * 1024;
    groups.push({
      groupFolder,
      fileCount: files.length,
      totalBytes,
      lastEventAt: latestMs > 0 ? new Date(latestMs).toISOString() : null,
      stale,
      oversized,
    });
  }

  groups.sort((a, b) => a.groupFolder.localeCompare(b.groupFolder));
  return { journalRoot, groups };
}

export interface MemoryDivergenceSnapshot {
  items: number;
  procedures: number;
  pinnedItems: number;
}

export interface MemoryDivergenceReport {
  journalRoot: string;
  liveDbPath: string;
  replayDbPath: string;
  live: MemoryDivergenceSnapshot;
  replayed: MemoryDivergenceSnapshot;
  diff: MemoryDivergenceSnapshot;
  hasDivergence: boolean;
}

function snapshotCounts(db: Database.Database): MemoryDivergenceSnapshot {
  const items = Number(
    (
      db
        .prepare(
          `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0`,
        )
        .get() as { count?: number }
    ).count || 0,
  );
  const procedures = Number(
    (
      db
        .prepare(
          `SELECT COUNT(1) AS count FROM memory_procedures WHERE is_deleted = 0`,
        )
        .get() as { count?: number }
    ).count || 0,
  );
  const pinnedItems = Number(
    (
      db
        .prepare(
          `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0 AND is_pinned = 1`,
        )
        .get() as { count?: number }
    ).count || 0,
  );
  return { items, procedures, pinnedItems };
}

function resolveLiveDbPath(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
  env: Record<string, string | undefined>,
): string {
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  return health.sqlitePath;
}

export async function inspectMemoryDivergence(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
  env: Record<string, string | undefined>,
): Promise<MemoryDivergenceReport> {
  const journalRoot = resolveJournalRoot(runtimeHome, settings, env);
  if (!fs.existsSync(journalRoot)) {
    throw new Error(`Journal root not found: ${journalRoot}`);
  }
  const liveDbPath = resolveLiveDbPath(runtimeHome, settings, env);
  if (!fs.existsSync(liveDbPath)) {
    throw new Error(`Live memory DB not found: ${liveDbPath}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-div-'));
  const replayDbPath = path.join(tempRoot, 'replay.db');
  try {
    const replayCode = await runMemoryReplayCommand([
      `--from=${journalRoot}`,
      `--to=${replayDbPath}`,
      '--overwrite',
    ]);
    if (replayCode !== 0) {
      throw new Error(`Replay failed with exit code ${replayCode}`);
    }

    const liveDb = new Database(liveDbPath, { readonly: true });
    const replayDb = new Database(replayDbPath, { readonly: true });
    try {
      const live = snapshotCounts(liveDb);
      const replayed = snapshotCounts(replayDb);
      const diff: MemoryDivergenceSnapshot = {
        items: live.items - replayed.items,
        procedures: live.procedures - replayed.procedures,
        pinnedItems: live.pinnedItems - replayed.pinnedItems,
      };
      const hasDivergence =
        diff.items !== 0 || diff.procedures !== 0 || diff.pinnedItems !== 0;
      return {
        journalRoot,
        liveDbPath,
        replayDbPath,
        live,
        replayed,
        diff,
        hasDivergence,
      };
    } finally {
      liveDb.close();
      replayDb.close();
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

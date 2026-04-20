import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import Database from 'better-sqlite3';
import { resolveClaudeAuthState } from '../core/config.js';
import {
  DisabledEmbeddingClient,
  OpenAIEmbeddingClient,
  type EmbeddingProvider,
} from '../memory/memory-embeddings.js';
import { CachedEmbeddingProvider } from '../memory/memory-embedding-cache.js';
import { MemoryIndexer } from '../memory/memory-indexer.js';
import { MemoryService } from '../memory/memory-service.js';
import { MemoryStore } from '../memory/memory-store.js';

import { readEnvFile } from './env-file.js';
import {
  collectMemoryStatus,
  formatMemoryStatusExtras,
} from './memory-status.js';
import {
  inspectMemoryDivergence,
  inspectMemoryHealth,
  inspectMemoryJournalStatus,
} from './memory-health.js';
import { envFilePath } from './runtime-home.js';
import {
  applyMemoryModelProfile,
  getMemoryModelProfileDefaults,
  type MemoryModelProfile,
  type MemoryModelTask,
  loadRuntimeSettings,
  saveRuntimeSettings,
  type EmbeddingProviderName,
  type RuntimeSettings,
} from './runtime-settings.js';

function usage(): string {
  return [
    'Usage:',
    '  myclaw memory status [--json]',
    '  myclaw memory search <query> [--source=<source>] [--limit=<n>]',
    '  myclaw memory list [--source=<source>] [--kind=<kind>] [--limit=<n>]',
    '  myclaw memory show <id>',
    '  myclaw memory reindex [--full]',
    '  myclaw memory embeddings <off|disabled|openai>',
    '  myclaw memory dreaming <on|off>',
    '  myclaw memory health journal-status',
    '  myclaw memory health divergence',
    '  myclaw memory counters',
    '  myclaw memory model set <extractor|dreaming|consolidation|sessionSummary> <model>',
    '  myclaw memory model profile <cheap|balanced|quality>',
  ].join('\n');
}

interface EffectiveModelRow {
  model: string;
  source: 'settings.yaml' | 'ANTHROPIC_MODEL' | 'default';
}

function safeRealpathSync(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function isInsideRoot(rootDir: string, candidatePath: string): boolean {
  const rootResolved = safeRealpathSync(rootDir);
  const candidateResolved = resolvePathWithRealParent(candidatePath);
  if (!rootResolved || !candidateResolved) return false;
  const relative = path.relative(rootResolved, candidateResolved);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function isSafeManagedFileDelete(
  memoryRoot: string,
  managedSubdir: string,
  targetPath: string,
): boolean {
  const managedRoot = path.join(memoryRoot, managedSubdir);
  if (!isInsideRoot(managedRoot, targetPath)) return false;
  try {
    const stat = fs.lstatSync(targetPath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function removeDeletedItemMirrorsBeforeFullReindex(
  sqlitePath: string,
  memoryRoot: string,
): void {
  if (!fs.existsSync(sqlitePath)) return;
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, file_path
         FROM memory_items
         WHERE is_deleted = 1
           AND (file_path IS NOT NULL OR id IS NOT NULL)`,
      )
      .all() as Array<{ id?: string; file_path?: string }>;
    const deletedIds = new Set<string>();
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      if (id) deletedIds.add(id);
      const filePath = typeof row.file_path === 'string' ? row.file_path : '';
      if (!filePath) continue;
      const resolved = path.resolve(filePath);
      if (!isSafeManagedFileDelete(memoryRoot, 'items', resolved)) continue;
      fs.rmSync(resolved, { force: true });
    }
    if (deletedIds.size === 0) return;
    const itemsRoot = path.join(memoryRoot, 'items');
    for (const filePath of walkMemoryFiles(itemsRoot)) {
      if (!isInsideRoot(memoryRoot, filePath)) continue;
      let raw = '';
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(raw);
      const frontmatterId = typeof fm.id === 'string' ? fm.id.trim() : '';
      if (!frontmatterId || !deletedIds.has(frontmatterId)) continue;
      fs.rmSync(filePath, { force: true });
    }
  } finally {
    db.close();
  }
}

function resolveEffectiveModel(
  configuredModel: string | undefined,
  globalModel: string | undefined,
  hardDefault: string,
): EffectiveModelRow {
  const configured = configuredModel?.trim();
  if (configured) {
    return { model: configured, source: 'settings.yaml' };
  }
  const global = globalModel?.trim();
  if (global) {
    return { model: global, source: 'ANTHROPIC_MODEL' };
  }
  return { model: hardDefault, source: 'default' };
}

function formatMemoryStatus(runtimeHome: string): string {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  const globalModel = env.ANTHROPIC_MODEL;
  const hardDefaults = getMemoryModelProfileDefaults('balanced');
  const extractorModel = resolveEffectiveModel(
    settings.memory.llm.models.extractor,
    globalModel,
    hardDefaults.extractor,
  );
  const dreamingModel = resolveEffectiveModel(
    settings.memory.llm.models.dreaming,
    globalModel,
    hardDefaults.dreaming,
  );
  const consolidationModel = resolveEffectiveModel(
    settings.memory.llm.models.consolidation,
    globalModel,
    hardDefaults.consolidation,
  );
  const sessionSummaryModel = resolveEffectiveModel(
    settings.memory.llm.models.sessionSummary,
    globalModel,
    hardDefaults.sessionSummary,
  );
  const claudeAuth = resolveClaudeAuthState({
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: env.ANTHROPIC_API_KEY,
  });
  return [
    'MyClaw Memory',
    '',
    `Memory: ${health.memoryEnabled ? 'on' : 'off'} (source: ${health.memorySource})`,
    `Storage: ${health.memoryCheck.status}`,
    `Memory root: ${health.memoryRoot} (source: ${health.memoryRootSource})`,
    `SQLite DB: ${health.sqlitePath} (source: ${health.sqlitePathSource})`,
    `Embeddings: ${health.embeddingsEnabled ? 'on' : 'off'}`,
    `Embedding provider: ${health.embeddingProvider} (${health.embeddingCheck.status}, source: ${health.embeddingProviderSource})`,
    `Embedding model: ${health.embeddingModel} (source: ${health.embeddingModelSource})`,
    `Dreaming: ${health.dreamingEnabled ? 'on' : 'off'} (source: ${health.dreamingSource})`,
    `Claude OAuth token: ${claudeAuth.hasOauthToken ? 'present' : 'missing'} (CLAUDE_CODE_OAUTH_TOKEN)`,
    `Claude API key: ${claudeAuth.hasApiKey ? 'present' : 'missing'} (ANTHROPIC_API_KEY)`,
    `Claude auth mode: ${claudeAuth.mode} (precedence: oauth -> api_key)`,
    `Model extractor: ${extractorModel.model} (source: ${extractorModel.source})`,
    `Model dreaming: ${dreamingModel.model} (source: ${dreamingModel.source})`,
    `Model consolidation: ${consolidationModel.model} (source: ${consolidationModel.source})`,
    `Model sessionSummary: ${sessionSummaryModel.model} (source: ${sessionSummaryModel.source})`,
  ].join('\n');
}

function formatJournalStatus(runtimeHome: string): string {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const report = inspectMemoryJournalStatus(runtimeHome, settings, env);
  const lines = [
    'Memory Journal Status',
    '',
    `Root: ${report.journalRoot}`,
    '',
  ];
  if (report.groups.length === 0) {
    lines.push('No journal groups found.');
    return lines.join('\n');
  }
  for (const group of report.groups) {
    lines.push(
      `${group.groupFolder}: files=${group.fileCount} bytes=${group.totalBytes} last_event=${group.lastEventAt || 'never'}${group.stale ? ' stale>24h' : ''}${group.oversized ? ' oversized>200MB' : ''}`,
    );
  }
  return lines.join('\n');
}

function formatDivergenceReport(
  report: Awaited<ReturnType<typeof inspectMemoryDivergence>>,
): string {
  return [
    'Memory Divergence',
    '',
    `Journal root: ${report.journalRoot}`,
    `Live DB: ${report.liveDbPath}`,
    `Items live/replayed/diff: ${report.live.items}/${report.replayed.items}/${report.diff.items}`,
    `Procedures live/replayed/diff: ${report.live.procedures}/${report.replayed.procedures}/${report.diff.procedures}`,
    `Pinned live/replayed/diff: ${report.live.pinnedItems}/${report.replayed.pinnedItems}/${report.diff.pinnedItems}`,
    `Divergence: ${report.hasDivergence ? 'yes' : 'no'}`,
  ].join('\n');
}

function setEmbeddings(
  runtimeHome: string,
  provider: EmbeddingProviderName,
): { ok: boolean; message?: string } {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  if (provider === 'openai' && !env.OPENAI_API_KEY?.trim()) {
    return {
      ok: false,
      message:
        'OPENAI_API_KEY is required only for OpenAI embeddings. Set it with `myclaw config set OPENAI_API_KEY <key>` or run `myclaw memory embeddings off`.',
    };
  }
  settings.memory.embeddings.enabled = provider === 'openai';
  settings.memory.embeddings.provider = provider;
  if (!settings.memory.embeddings.model.trim()) {
    settings.memory.embeddings.model = 'text-embedding-3-large';
  }
  saveRuntimeSettings(runtimeHome, settings);
  return { ok: true };
}

function setDreaming(runtimeHome: string, enabled: boolean): void {
  const settings = loadRuntimeSettings(runtimeHome);
  settings.memory.dreaming.enabled = enabled;
  if (enabled && !settings.memory.enabled) settings.memory.enabled = true;
  saveRuntimeSettings(runtimeHome, settings);
}

function parseModelTask(raw: string | undefined): MemoryModelTask | null {
  if (!raw) return null;
  const normalized = raw.trim();
  if (normalized === 'extractor') return 'extractor';
  if (normalized === 'dreaming') return 'dreaming';
  if (normalized === 'consolidation') return 'consolidation';
  if (
    normalized === 'sessionSummary' ||
    normalized === 'session_summary' ||
    normalized === 'session-summary'
  ) {
    return 'sessionSummary';
  }
  return null;
}

function setTaskModel(
  runtimeHome: string,
  task: MemoryModelTask,
  model: string,
): { ok: boolean; message?: string } {
  const trimmed = model.trim();
  if (!trimmed) {
    return { ok: false, message: 'Model must be a non-empty string.' };
  }
  const settings = loadRuntimeSettings(runtimeHome);
  settings.memory.llm.models[task] = trimmed;
  saveRuntimeSettings(runtimeHome, settings);
  return { ok: true };
}

function setModelProfile(
  runtimeHome: string,
  profile: MemoryModelProfile,
): void {
  const settings = loadRuntimeSettings(runtimeHome);
  applyMemoryModelProfile(settings, profile);
  saveRuntimeSettings(runtimeHome, settings);
}

function resolveMemoryRoot(
  runtimeHome: string,
  env: Record<string, string | undefined>,
  settingsOverride?: RuntimeSettings,
): string {
  const settings = settingsOverride || loadRuntimeSettings(runtimeHome);
  const raw =
    process.env.MEMORY_ROOT?.trim() ||
    env.MEMORY_ROOT?.trim() ||
    settings.memory.root?.trim() ||
    'memory';
  return path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(runtimeHome, raw);
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

function assertPathInsideRuntimeHome(
  runtimeHome: string,
  targetPath: string,
  description: string,
): string {
  const runtimeReal = safeRealpathSync(path.resolve(runtimeHome));
  if (!runtimeReal) {
    throw new Error(
      `Refusing reindex: runtime home must resolve to an existing path (${runtimeHome}).`,
    );
  }
  const canonicalTarget = resolvePathWithRealParent(targetPath);
  if (!canonicalTarget) {
    throw new Error(
      `Refusing reindex: ${description} must resolve to an existing parent path.`,
    );
  }
  const relative = path.relative(runtimeReal, canonicalTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing reindex: ${description} must resolve inside runtime home (${runtimeReal}).`,
    );
  }
  return canonicalTarget;
}

function createReindexEmbeddingProvider(
  settings: RuntimeSettings,
  env: Record<string, string | undefined>,
): EmbeddingProvider {
  if (
    !settings.memory.embeddings.enabled ||
    settings.memory.embeddings.provider === 'disabled'
  ) {
    return new DisabledEmbeddingClient();
  }
  if (settings.memory.embeddings.provider !== 'openai') {
    throw new Error(
      `Unknown embedding provider "${settings.memory.embeddings.provider}"`,
    );
  }
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || null;
  return new OpenAIEmbeddingClient(apiKey, settings.memory.embeddings.model);
}

async function runScopedReindex(input: {
  memoryRoot: string;
  sqlitePath: string;
  settings: RuntimeSettings;
  env: Record<string, string | undefined>;
}): Promise<{ scanned: number; reindexed: number }> {
  const store = new MemoryStore(input.sqlitePath);
  try {
    const baseProvider = createReindexEmbeddingProvider(
      input.settings,
      input.env,
    );
    const embeddings = new CachedEmbeddingProvider(baseProvider, store);
    embeddings.validateConfiguration();
    const indexer = new MemoryIndexer(input.memoryRoot, store, embeddings);
    return await indexer.reindexStaleFilesAndWait();
  } finally {
    store.close();
  }
}

function walkMemoryFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return out;
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return out;
  const block = normalized.slice(4, end);
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    out[key] = value;
  }
  return out;
}

function parseOption(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] || '';
    if (arg === `--${name}`) return args[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw || '');
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function sourceFromPath(memoryRoot: string, filePath: string): string {
  const relative = path.relative(memoryRoot, filePath);
  const source = relative.split(path.sep)[0] || 'unknown';
  return source;
}

export async function runMemoryCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, value, extra] = args;

  if (!command || command === 'status') {
    const statusFlags = command ? args.slice(1) : [];
    const jsonMode = statusFlags.includes('--json');
    const snapshot = collectMemoryStatus(runtimeHome);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      return 0;
    }
    p.note(formatMemoryStatus(runtimeHome), 'Memory');
    p.note(formatMemoryStatusExtras(snapshot), 'Memory Runtime');
    return 0;
  }

  if (command === 'embeddings') {
    const normalized = value === 'off' ? 'disabled' : value;
    if (!['disabled', 'openai'].includes(normalized || '')) {
      p.log.error(usage());
      return 1;
    }
    const result = setEmbeddings(
      runtimeHome,
      normalized as EmbeddingProviderName,
    );
    if (!result.ok) {
      p.log.error(result.message || 'Could not update embeddings settings.');
      return 1;
    }
    p.log.success(`Memory embeddings set to ${normalized} in settings.yaml.`);
    return 0;
  }

  if (command === 'dreaming') {
    if (value !== 'on' && value !== 'off') {
      p.log.error(usage());
      return 1;
    }
    setDreaming(runtimeHome, value === 'on');
    p.log.success(`Memory dreaming set to ${value} in settings.yaml.`);
    return 0;
  }

  if (command === 'health') {
    if (value === 'journal-status') {
      p.note(formatJournalStatus(runtimeHome), 'Memory Health');
      return 0;
    }
    if (value === 'divergence') {
      const settings = loadRuntimeSettings(runtimeHome);
      const env = readEnvFile(envFilePath(runtimeHome));
      let report: Awaited<ReturnType<typeof inspectMemoryDivergence>>;
      try {
        report = await inspectMemoryDivergence(runtimeHome, settings, env);
      } catch (err) {
        p.log.error(
          `Memory divergence check failed: ${(err as Error).message}`,
        );
        return 1;
      }
      p.note(formatDivergenceReport(report), 'Memory Health');
      if (report.hasDivergence) {
        p.log.error(
          'Memory divergence detected between live DB and journal replay.',
        );
        return 1;
      }
      return 0;
    }
    p.log.error(usage());
    return 1;
  }

  if (command === 'search') {
    const query = value?.trim() || '';
    if (!query) {
      p.log.error(usage());
      return 1;
    }
    const flags = args.slice(1);
    const sourceFilter = parseOption(flags, 'source')?.trim();
    const limit = parseLimit(parseOption(flags, 'limit'), 20);
    const env = readEnvFile(envFilePath(runtimeHome));
    const memoryRoot = resolveMemoryRoot(runtimeHome, env);
    const queryLower = query.toLowerCase();
    const matches: Array<{
      filePath: string;
      source: string;
      id: string;
      snippet: string;
    }> = [];
    let skippedUnreadable = 0;
    for (const filePath of walkMemoryFiles(memoryRoot)) {
      const source = sourceFromPath(memoryRoot, filePath);
      if (sourceFilter && source !== sourceFilter) continue;
      let raw = '';
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch {
        skippedUnreadable += 1;
        continue;
      }
      const lower = raw.toLowerCase();
      if (!lower.includes(queryLower)) continue;
      const fm = parseFrontmatter(raw);
      const firstLine = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith('---'));
      matches.push({
        filePath,
        source,
        id: fm.id || path.basename(filePath, '.md'),
        snippet: firstLine || '',
      });
      if (matches.length >= limit) break;
    }
    if (skippedUnreadable > 0) {
      p.log.warn(`Skipped ${skippedUnreadable} unreadable memory file(s).`);
    }
    if (matches.length === 0) {
      p.note('No matches found.', 'Memory Search');
      return 0;
    }
    p.note(
      matches
        .map(
          (match) =>
            `[${match.source}] ${match.id}\n  ${match.filePath}\n  ${match.snippet}`,
        )
        .join('\n\n'),
      'Memory Search',
    );
    return 0;
  }

  if (command === 'list') {
    const flags = args.slice(1);
    const sourceFilter = parseOption(flags, 'source')?.trim();
    const kindFilter = parseOption(flags, 'kind')?.trim();
    const limit = parseLimit(parseOption(flags, 'limit'), 50);
    const env = readEnvFile(envFilePath(runtimeHome));
    const memoryRoot = resolveMemoryRoot(runtimeHome, env);
    const rows: Array<{
      source: string;
      kind: string;
      id: string;
      filePath: string;
    }> = [];
    let skippedUnreadable = 0;
    for (const filePath of walkMemoryFiles(memoryRoot)) {
      const source = sourceFromPath(memoryRoot, filePath);
      if (sourceFilter && source !== sourceFilter) continue;
      let raw = '';
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch {
        skippedUnreadable += 1;
        continue;
      }
      const fm = parseFrontmatter(raw);
      const kind = fm.kind || '-';
      if (kindFilter && kind !== kindFilter) continue;
      rows.push({
        source,
        kind,
        id: fm.id || path.basename(filePath, '.md'),
        filePath,
      });
      if (rows.length >= limit) break;
    }
    if (skippedUnreadable > 0) {
      p.log.warn(`Skipped ${skippedUnreadable} unreadable memory file(s).`);
    }
    if (rows.length === 0) {
      p.note('No memory files found.', 'Memory List');
      return 0;
    }
    p.note(
      rows
        .map(
          (row) => `[${row.source}] ${row.kind} ${row.id}\n  ${row.filePath}`,
        )
        .join('\n\n'),
      'Memory List',
    );
    return 0;
  }

  if (command === 'show') {
    const targetId = value?.trim() || '';
    if (!targetId) {
      p.log.error(usage());
      return 1;
    }
    const env = readEnvFile(envFilePath(runtimeHome));
    const memoryRoot = resolveMemoryRoot(runtimeHome, env);
    let skippedUnreadable = 0;
    for (const filePath of walkMemoryFiles(memoryRoot)) {
      let raw = '';
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch {
        skippedUnreadable += 1;
        continue;
      }
      const fm = parseFrontmatter(raw);
      const fileId = fm.id || path.basename(filePath, '.md');
      if (fileId !== targetId) continue;
      process.stdout.write(raw.endsWith('\n') ? raw : `${raw}\n`);
      return 0;
    }
    if (skippedUnreadable > 0) {
      p.log.warn(`Skipped ${skippedUnreadable} unreadable memory file(s).`);
    }
    p.log.error(`Memory entry not found: ${targetId}`);
    return 1;
  }

  if (command === 'reindex') {
    const full = args.includes('--full');
    const settings = loadRuntimeSettings(runtimeHome);
    const env = readEnvFile(envFilePath(runtimeHome));
    const configuredMemoryRoot = resolveMemoryRoot(runtimeHome, env, settings);
    const expectedDbPath = path.resolve(
      configuredMemoryRoot,
      '.cache',
      'memory.db',
    );
    let safeMemoryRoot: string;
    let safeDbPath: string;
    try {
      safeMemoryRoot = assertPathInsideRuntimeHome(
        runtimeHome,
        configuredMemoryRoot,
        'memory.root',
      );
      safeDbPath = assertPathInsideRuntimeHome(
        runtimeHome,
        expectedDbPath,
        'memory sqlite path',
      );
    } catch (err) {
      p.log.error((err as Error).message);
      return 1;
    }
    if (full) {
      const health = inspectMemoryHealth(runtimeHome, settings, env);
      const actualDbPath = resolvePathWithRealParent(health.sqlitePath);
      if (!actualDbPath) {
        p.log.error(
          `Refusing full reindex: sqlite path must resolve to an existing parent (${health.sqlitePath}).`,
        );
        return 1;
      }
      if (actualDbPath !== safeDbPath) {
        p.log.error(
          `Refusing full reindex: resolved DB path mismatch (${actualDbPath} != ${safeDbPath}).`,
        );
        return 1;
      }
      try {
        removeDeletedItemMirrorsBeforeFullReindex(safeDbPath, safeMemoryRoot);
      } catch (err) {
        p.log.error(
          `Failed to remove deleted memory mirrors before full reindex: ${(err as Error).message}`,
        );
        return 1;
      }
      try {
        fs.rmSync(safeDbPath, { force: true });
      } catch (err) {
        p.log.error(
          `Failed to remove memory DB for full reindex: ${(err as Error).message}`,
        );
        return 1;
      }
    }
    let result: { scanned: number; reindexed: number };
    try {
      result = await runScopedReindex({
        memoryRoot: safeMemoryRoot,
        sqlitePath: safeDbPath,
        settings,
        env,
      });
    } catch (err) {
      p.log.error(`Reindex failed: ${(err as Error).message}`);
      return 1;
    }
    p.log.success(
      `Reindex complete. scanned=${result.scanned} reindexed=${result.reindexed}`,
    );
    return 0;
  }

  if (command === 'model') {
    if (value === 'set') {
      const task = parseModelTask(args[2]);
      const model = args[3] || '';
      if (!task || !model.trim()) {
        p.log.error(usage());
        return 1;
      }
      const result = setTaskModel(runtimeHome, task, model);
      if (!result.ok) {
        p.log.error(result.message || 'Could not update model setting.');
        return 1;
      }
      p.log.success(
        `Memory model for ${task} set to ${model.trim()} in settings.yaml.`,
      );
      return 0;
    }

    if (value === 'profile') {
      const profile = extra as MemoryModelProfile | undefined;
      if (!profile || !['cheap', 'balanced', 'quality'].includes(profile)) {
        p.log.error(usage());
        return 1;
      }
      setModelProfile(runtimeHome, profile);
      p.log.success(`Memory model profile set to ${profile} in settings.yaml.`);
      return 0;
    }

    p.log.error(usage());
    return 1;
  }

  if (command === 'counters') {
    const counters = MemoryService.getCountersSnapshot();
    p.note(
      Object.entries(counters)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n'),
      'Memory Counters',
    );
    return 0;
  }

  p.log.error(usage());
  return 1;
}

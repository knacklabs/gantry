import fs from 'fs';
import path from 'path';

import { AGENT_MEMORY_ROOT } from '../core/config.js';
import { MemoryItem, MemoryProcedure } from './memory-types.js';

export type SessionArchiveCause =
  | 'new-session'
  | 'manual-compact'
  | 'auto-compact'
  | 'stale-session'
  | 'abandoned-session';

export interface AgentMemoryLayout {
  root: string;
  profileDir: string;
  journalDir: string;
  sessionsDir: string;
  proceduresDir: string;
  knowledgeDir: string;
  rawDir: string;
  cacheDir: string;
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const relative = path.relative(baseDir, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes AGENT_MEMORY_ROOT: ${resolvedPath}`);
  }
}

function sanitizeSegment(input: string, fallback: string): string {
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function formatDateParts(date: Date): {
  year: string;
  month: string;
  day: string;
} {
  const isoDate = date.toISOString().slice(0, 10);
  const [year, month, day] = isoDate.split('-');
  return { year, month, day };
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function resolveConfiguredRoot(rootOverride?: string): string {
  const configuredRoot =
    rootOverride !== undefined
      ? rootOverride.trim()
      : process.env.AGENT_MEMORY_ROOT?.trim() || AGENT_MEMORY_ROOT.trim();
  if (!configuredRoot) {
    throw new Error(
      'AGENT_MEMORY_ROOT is required. Set AGENT_MEMORY_ROOT to an absolute path for durable memory.',
    );
  }
  return path.resolve(configuredRoot);
}

let singleton: AgentMemoryRootService | null = null;

export class AgentMemoryRootService {
  private readonly layout: AgentMemoryLayout;

  constructor(rootOverride?: string) {
    const root = resolveConfiguredRoot(rootOverride);
    this.layout = {
      root,
      profileDir: path.join(root, 'profile'),
      journalDir: path.join(root, 'journal'),
      sessionsDir: path.join(root, 'sessions'),
      proceduresDir: path.join(root, 'procedures'),
      knowledgeDir: path.join(root, 'knowledge'),
      rawDir: path.join(root, '.raw'),
      cacheDir: path.join(root, '.cache'),
    };
    this.ensureLayout();
  }

  static getInstance(): AgentMemoryRootService {
    if (!singleton) {
      singleton = new AgentMemoryRootService();
    }
    return singleton;
  }

  static resetForTests(): void {
    singleton = null;
  }

  getLayout(): AgentMemoryLayout {
    return { ...this.layout };
  }

  getSqliteCachePath(): string {
    return this.resolveWithinRoot(path.join(this.layout.cacheDir, 'memory.db'));
  }

  resolveJournalPath(date = new Date()): string {
    const { year, month } = formatDateParts(date);
    const dayStamp = date.toISOString().slice(0, 10);
    return this.resolveWithinRoot(
      path.join(this.layout.journalDir, year, month, `${dayStamp}.md`),
    );
  }

  appendJournalEntry(input: {
    title: string;
    lines: string[];
    timestamp?: Date;
  }): string {
    const now = input.timestamp ?? new Date();
    const journalPath = this.resolveJournalPath(now);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const entryLines = [
      `## ${now.toISOString()} - ${input.title}`,
      '',
      ...input.lines.map((line) => `- ${line}`),
      '',
    ];
    fs.appendFileSync(journalPath, entryLines.join('\n'));
    return journalPath;
  }

  writeMemoryItem(item: MemoryItem): string {
    const filePath = this.resolveWithinRoot(
      path.join(
        this.layout.profileDir,
        `${sanitizeSegment(item.id, 'memory')}.md`,
      ),
    );
    const lines = [
      '# Memory Item',
      '',
      `id: ${item.id}`,
      `scope: ${item.scope}`,
      `group_folder: ${item.group_folder}`,
      `user_id: ${item.user_id || ''}`,
      `kind: ${item.kind}`,
      `key: ${item.key}`,
      `source: ${item.source}`,
      `confidence: ${item.confidence}`,
      `version: ${item.version}`,
      `created_at: ${item.created_at}`,
      `updated_at: ${item.updated_at}`,
      '',
      '## Value',
      '',
      item.value.trim(),
      '',
    ];
    writeFileAtomic(filePath, lines.join('\n'));
    return filePath;
  }

  writeProcedure(procedure: MemoryProcedure): string {
    const filePath = this.resolveWithinRoot(
      path.join(
        this.layout.proceduresDir,
        `${sanitizeSegment(procedure.id, 'procedure')}.md`,
      ),
    );
    const lines = [
      '# Procedure',
      '',
      `id: ${procedure.id}`,
      `scope: ${procedure.scope}`,
      `group_folder: ${procedure.group_folder}`,
      `title: ${procedure.title}`,
      `tags: ${procedure.tags.join(', ')}`,
      `source: ${procedure.source}`,
      `confidence: ${procedure.confidence}`,
      `version: ${procedure.version}`,
      `created_at: ${procedure.created_at}`,
      `updated_at: ${procedure.updated_at}`,
      '',
      '## Body',
      '',
      procedure.body.trim(),
      '',
    ];
    writeFileAtomic(filePath, lines.join('\n'));
    return filePath;
  }

  writeSessionSummary(input: {
    groupFolder: string;
    sessionId: string;
    cause: SessionArchiveCause;
    title: string;
    markdown: string;
    timestamp?: Date;
    slug?: string;
  }): string {
    const now = input.timestamp ?? new Date();
    const { year, month } = formatDateParts(now);
    const dayStamp = now.toISOString().slice(0, 10);
    const dayDir = this.resolveWithinRoot(
      path.join(this.layout.sessionsDir, year, month, dayStamp),
    );
    fs.mkdirSync(dayDir, { recursive: true });

    const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, '');
    const slug = sanitizeSegment(
      input.slug || input.title || input.sessionId,
      'session',
    );
    const fileName = `${hhmmss}-${sanitizeSegment(input.cause, 'session')}-${slug}.md`;
    const filePath = this.resolveWithinRoot(path.join(dayDir, fileName));
    const content = [
      '---',
      `session_id: ${input.sessionId}`,
      `group_folder: ${input.groupFolder}`,
      `cause: ${input.cause}`,
      `archived_at: ${now.toISOString()}`,
      '---',
      '',
      input.markdown.trim(),
      '',
    ].join('\n');
    writeFileAtomic(filePath, content);
    return filePath;
  }

  private ensureLayout(): void {
    fs.mkdirSync(this.layout.root, { recursive: true });
    const dirs = [
      this.layout.profileDir,
      this.layout.journalDir,
      this.layout.sessionsDir,
      this.layout.proceduresDir,
      this.layout.knowledgeDir,
      this.layout.rawDir,
      this.layout.cacheDir,
    ];
    for (const dir of dirs) {
      const resolved = this.resolveWithinRoot(dir);
      fs.mkdirSync(resolved, { recursive: true });
    }
  }

  private resolveWithinRoot(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    ensureWithinBase(this.layout.root, resolved);
    return resolved;
  }
}

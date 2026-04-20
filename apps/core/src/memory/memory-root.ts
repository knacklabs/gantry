import fs from 'fs';
import path from 'path';

import { MEMORY_ROOT } from '../core/config.js';

export type SessionArchiveCause =
  | 'new-session'
  | 'manual-compact'
  | 'auto-compact'
  | 'stale-session'
  | 'abandoned-session';

export interface MemoryLayout {
  root: string;
  itemsDir: string;
  proceduresDir: string;
  sessionsDir: string;
  knowledgeDir: string;
  dreamsDir: string;
  dailyDir: string;
  journalDir: string;
  cacheDir: string;
  rawDir: string;
}

export interface LatestSessionRecap {
  filePath: string;
  summary: string;
  openLoops: string;
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const relative = path.relative(baseDir, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes memory root: ${resolvedPath}`);
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
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

let singleton: MemoryRootService | null = null;

export class MemoryRootService {
  private readonly layout: MemoryLayout;

  constructor(rootOverride?: string) {
    const resolvedRoot = path.resolve(rootOverride?.trim() || MEMORY_ROOT);
    this.layout = {
      root: resolvedRoot,
      itemsDir: path.join(resolvedRoot, 'items'),
      proceduresDir: path.join(resolvedRoot, 'procedures'),
      sessionsDir: path.join(resolvedRoot, 'sessions'),
      knowledgeDir: path.join(resolvedRoot, 'knowledge'),
      dreamsDir: path.join(resolvedRoot, 'dreams'),
      dailyDir: path.join(resolvedRoot, 'daily'),
      journalDir: path.join(resolvedRoot, '.journal'),
      cacheDir: path.join(resolvedRoot, '.cache'),
      rawDir: path.join(resolvedRoot, '.raw'),
    };
    this.ensureLayout();
  }

  static getInstance(): MemoryRootService {
    if (!singleton) singleton = new MemoryRootService();
    return singleton;
  }

  static resetForTests(): void {
    singleton = null;
  }

  static setRootForTests(root: string): void {
    singleton = new MemoryRootService(root);
  }

  getLayout(): MemoryLayout {
    return { ...this.layout };
  }

  getSqliteCachePath(): string {
    return this.resolveWithinRoot(path.join(this.layout.cacheDir, 'memory.db'));
  }

  resolveJournalPath(date = new Date()): string {
    const { year, month } = formatDateParts(date);
    return this.resolveWithinRoot(
      path.join(
        this.layout.journalDir,
        year,
        month,
        `events-${year}-${month}.jsonl`,
      ),
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
      JSON.stringify({
        ts: now.toISOString(),
        title: input.title,
        lines: input.lines,
      }),
      '',
    ];
    fs.appendFileSync(journalPath, entryLines.join('\n'));
    return journalPath;
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
    const { year, month, day } = formatDateParts(now);
    const dayDir = this.resolveWithinRoot(
      path.join(this.layout.sessionsDir, year, month, day),
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

  getLatestSessionRecap(groupFolder: string): LatestSessionRecap | null {
    const files = this.listMarkdownFiles(this.layout.sessionsDir);
    const sorted = files.sort((a, b) => b.localeCompare(a));
    for (const filePath of sorted) {
      const recap = this.parseSessionRecapFile(filePath, groupFolder);
      if (recap) return recap;
    }
    return null;
  }

  private ensureLayout(): void {
    fs.mkdirSync(this.layout.root, { recursive: true });
    const dirs = [
      this.layout.itemsDir,
      this.layout.proceduresDir,
      this.layout.sessionsDir,
      this.layout.knowledgeDir,
      this.layout.dreamsDir,
      this.layout.dailyDir,
      this.layout.journalDir,
      this.layout.cacheDir,
      this.layout.rawDir,
    ];
    for (const dir of dirs) {
      const resolved = this.resolveWithinRoot(dir);
      fs.mkdirSync(resolved, { recursive: true });
    }
  }

  private listMarkdownFiles(root: string): string[] {
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
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
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.md')) {
          out.push(full);
        }
      }
    }
    return out;
  }

  private parseSessionRecapFile(
    filePath: string,
    groupFolder: string,
  ): LatestSessionRecap | null {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
    const normalized = content.replace(/\r\n/g, '\n');
    const groupMatch = normalized.match(/^group_folder:\s*(.+)$/m);
    if (!groupMatch || groupMatch[1]?.trim() !== groupFolder) {
      return null;
    }
    const body = normalized.replace(/^---[\s\S]*?---\n?/, '');
    const summary = this.extractSection(body, 'Summary');
    const openLoops = this.extractSection(body, 'Open loops');
    if (!summary && !openLoops) return null;
    return {
      filePath,
      summary: summary || 'No summary available.',
      openLoops: openLoops || 'No open loops recorded.',
    };
  }

  private extractSection(markdown: string, heading: string): string {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRegex = new RegExp(
      `^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\s*$)`,
      'im',
    );
    const match = markdown.match(sectionRegex);
    if (!match) return '';
    return match[1]!.trim();
  }

  private resolveWithinRoot(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    ensureWithinBase(this.layout.root, resolved);
    return resolved;
  }
}

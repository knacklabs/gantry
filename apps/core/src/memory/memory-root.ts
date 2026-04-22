import fs from 'fs';
import path from 'path';

import { memoryStorageDir } from '../core/config.js';

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

interface LatestSessionRecapIndex {
  version: 1;
  groups: Record<
    string,
    {
      filePath: string;
      summary: string;
      openLoops: string;
      archivedAt: string;
    }
  >;
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
  private latestSessionRecapIndex: LatestSessionRecapIndex | null = null;

  constructor(rootOverride?: string) {
    const resolvedRoot = path.resolve(rootOverride?.trim() || memoryStorageDir);
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
    const recap = this.parseSessionRecapContent(
      content,
      filePath,
      input.groupFolder,
    );
    if (recap) {
      this.updateLatestSessionRecapIndex(input.groupFolder, {
        ...recap,
        archivedAt: now.toISOString(),
      });
    }
    return filePath;
  }

  getLatestSessionRecap(groupFolder: string): LatestSessionRecap | null {
    const index = this.readLatestSessionRecapIndex();
    const entry = index.groups[groupFolder];
    if (!entry) {
      return this.rebuildLatestSessionRecapForGroup(groupFolder);
    }
    return {
      filePath: entry.filePath,
      summary: entry.summary,
      openLoops: entry.openLoops,
    };
  }

  private rebuildLatestSessionRecapForGroup(
    groupFolder: string,
  ): LatestSessionRecap | null {
    let latest: (LatestSessionRecap & { archivedAt: string }) | null = null;
    const scan = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        let content = '';
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          continue;
        }
        const recap = this.parseSessionRecapContent(
          content,
          fullPath,
          groupFolder,
        );
        if (!recap) continue;
        const archivedAt =
          content.match(/^archived_at:\s*(.+)$/m)?.[1]?.trim() ||
          '1970-01-01T00:00:00.000Z';
        if (!latest || archivedAt > latest.archivedAt) {
          latest = { ...recap, archivedAt };
        }
      }
    };
    scan(this.layout.sessionsDir);
    if (!latest) return null;
    const latestRecap = latest as LatestSessionRecap & { archivedAt: string };
    this.updateLatestSessionRecapIndex(groupFolder, latestRecap);
    return {
      filePath: latestRecap.filePath,
      summary: latestRecap.summary,
      openLoops: latestRecap.openLoops,
    };
  }

  private getLatestSessionRecapIndexPath(): string {
    return this.resolveWithinRoot(
      path.join(this.layout.cacheDir, 'latest-session-recaps.json'),
    );
  }

  private readLatestSessionRecapIndex(): LatestSessionRecapIndex {
    if (this.latestSessionRecapIndex) return this.latestSessionRecapIndex;
    const indexPath = this.getLatestSessionRecapIndexPath();
    try {
      const parsed = JSON.parse(
        fs.readFileSync(indexPath, 'utf-8'),
      ) as Partial<LatestSessionRecapIndex>;
      if (parsed.version !== 1 || !parsed.groups) {
        this.latestSessionRecapIndex = { version: 1, groups: {} };
        return this.latestSessionRecapIndex;
      }
      this.latestSessionRecapIndex = {
        version: 1,
        groups: parsed.groups,
      };
      return this.latestSessionRecapIndex;
    } catch {
      this.latestSessionRecapIndex = { version: 1, groups: {} };
      return this.latestSessionRecapIndex;
    }
  }

  private writeLatestSessionRecapIndex(index: LatestSessionRecapIndex): void {
    this.latestSessionRecapIndex = index;
    writeFileAtomic(
      this.getLatestSessionRecapIndexPath(),
      `${JSON.stringify(index, null, 2)}\n`,
    );
  }

  private updateLatestSessionRecapIndex(
    groupFolder: string,
    recap: LatestSessionRecap & { archivedAt: string },
  ): void {
    const index = this.readLatestSessionRecapIndex();
    const existing = index.groups[groupFolder];
    if (existing && existing.archivedAt > recap.archivedAt) {
      return;
    }
    index.groups[groupFolder] = {
      filePath: recap.filePath,
      summary: recap.summary,
      openLoops: recap.openLoops,
      archivedAt: recap.archivedAt,
    };
    this.writeLatestSessionRecapIndex(index);
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

  private parseSessionRecapContent(
    content: string,
    filePath: string,
    groupFolder: string,
  ): LatestSessionRecap | null {
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

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryRootService } from '@core/memory/memory-root.js';

const tempRoots: string[] = [];

afterEach(() => {
  MemoryRootService.resetForTests();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('MemoryRootService', () => {
  it('creates the required memory layout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new MemoryRootService(root);
    const layout = service.getLayout();

    expect(fs.existsSync(layout.itemsDir)).toBe(true);
    expect(fs.existsSync(layout.journalDir)).toBe(true);
    expect(fs.existsSync(layout.sessionsDir)).toBe(true);
    expect(fs.existsSync(layout.proceduresDir)).toBe(true);
    expect(fs.existsSync(layout.knowledgeDir)).toBe(true);
    expect(fs.existsSync(layout.rawDir)).toBe(true);
    expect(fs.existsSync(layout.cacheDir)).toBe(true);
    expect(service.getSqliteCachePath()).toContain(
      path.join('.cache', 'memory.db'),
    );
  });

  it('uses singleton root override for tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    MemoryRootService.setRootForTests(root);
    const service = MemoryRootService.getInstance();
    expect(service.getLayout().root).toBe(path.resolve(root));
  });

  it('writes session summaries only under sessions/YYYY/MM/YYYY-MM-DD', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new MemoryRootService(root);
    const filePath = service.writeSessionSummary({
      groupFolder: 'team-alpha',
      sessionId: 'session-123',
      cause: 'new-session',
      title: 'Session summary',
      markdown: '# Session summary',
      timestamp: new Date('2026-04-10T11:22:33.000Z'),
    });

    expect(filePath).toContain(path.join('sessions', '2026', '04', '10'));
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('appends JSONL journal entries under .journal/YYYY/MM', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new MemoryRootService(root);
    const ts = new Date('2026-04-10T11:22:33.000Z');
    const filePath = service.appendJournalEntry({
      title: 'event-test',
      lines: ['line-a', 'line-b'],
      timestamp: ts,
    });
    expect(filePath).toContain(path.join('.journal', '2026', '04'));
    const payload = fs.readFileSync(filePath, 'utf-8');
    expect(payload).toContain('"title":"event-test"');
    expect(payload).toContain('"lines":["line-a","line-b"]');
  });

  it('returns latest recap for group by parsing summary and open loops sections', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new MemoryRootService(root);
    service.writeSessionSummary({
      groupFolder: 'team-a',
      sessionId: 's1',
      cause: 'new-session',
      title: 'older',
      markdown: [
        '## Summary',
        'Older summary.',
        '',
        '## Open loops',
        '- old loop',
      ].join('\n'),
      timestamp: new Date('2026-04-10T11:00:00.000Z'),
    });
    service.writeSessionSummary({
      groupFolder: 'team-a',
      sessionId: 's2',
      cause: 'new-session',
      title: 'newer',
      markdown: [
        '## Summary',
        'New summary.',
        '',
        '## Open loops',
        '- new loop',
      ].join('\n'),
      timestamp: new Date('2026-04-10T11:30:00.000Z'),
    });

    const recap = service.getLatestSessionRecap('team-a');
    expect(recap).not.toBeNull();
    expect(recap?.summary).toContain('New summary.');
    expect(recap?.openLoops).toContain('new loop');
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryJournal } from '@core/memory/memory-journal.js';

const tempRoots: string[] = [];
const originalDisabled = process.env.MYCLAW_MEMORY_JOURNAL_DISABLED;

afterEach(() => {
  process.env.MYCLAW_MEMORY_JOURNAL_DISABLED = originalDisabled;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('MemoryJournal', () => {
  it('writes JSONL records under group/month files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-journal-'));
    tempRoots.push(root);
    const journal = new MemoryJournal(root);

    const record = journal.append({
      kind: 'memory.item.saved',
      group_folder: 'telegram_kai-dev',
      scope: 'group',
      actor: 'extractor:precompact',
      payload: {
        id: 'mem-1',
        key: 'preference:style',
      },
      ts: '2026-04-18T10:00:00.000Z',
    });
    journal.close();

    expect(record).not.toBeNull();
    const filePath = path.join(
      root,
      'telegram_kai-dev',
      'events-2026-04.jsonl',
    );
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] || '{}') as {
      kind?: string;
      actor?: string;
    };
    expect(parsed.kind).toBe('memory.item.saved');
    expect(parsed.actor).toBe('extractor:precompact');
  });

  it('maps global group records into _global directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-journal-'));
    tempRoots.push(root);
    const journal = new MemoryJournal(root);

    journal.append({
      kind: 'reflection.completed',
      group_folder: '_global',
      actor: 'agent',
      payload: {
        trigger: 'session-end',
      },
      ts: '2026-04-18T10:00:00.000Z',
    });
    journal.close();

    const filePath = path.join(root, '_global', 'events-2026-04.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('honors MYCLAW_MEMORY_JOURNAL_DISABLED kill-switch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-journal-'));
    tempRoots.push(root);
    process.env.MYCLAW_MEMORY_JOURNAL_DISABLED = '1';
    const journal = new MemoryJournal(root);

    const result = journal.append({
      kind: 'memory.item.saved',
      group_folder: 'team',
      scope: 'group',
      actor: 'agent',
      payload: { id: 'mem-1' },
      ts: '2026-04-18T10:00:00.000Z',
    });
    journal.close();

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(root, 'team'))).toBe(false);
  });

  it('sanitizes dot-segment group folders to stay within root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-journal-'));
    tempRoots.push(root);
    const journal = new MemoryJournal(root);

    const record = journal.append({
      kind: 'memory.item.saved',
      group_folder: '..',
      scope: 'group',
      actor: 'agent',
      payload: { id: 'safe' },
      ts: '2026-04-18T10:00:00.000Z',
    });
    journal.close();

    expect(record).not.toBeNull();
    const expectedFile = path.join(root, '_', 'events-2026-04.jsonl');
    expect(fs.existsSync(expectedFile)).toBe(true);
  });
});

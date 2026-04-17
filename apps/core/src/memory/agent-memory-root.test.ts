import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentMemoryRootService } from './agent-memory-root.js';

const tempRoots: string[] = [];

afterEach(() => {
  AgentMemoryRootService.resetForTests();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('AgentMemoryRootService', () => {
  it('creates the required memory layout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new AgentMemoryRootService(root);
    const layout = service.getLayout();

    expect(fs.existsSync(layout.profileDir)).toBe(true);
    expect(fs.existsSync(layout.journalDir)).toBe(true);
    expect(fs.existsSync(layout.sessionsDir)).toBe(true);
    expect(fs.existsSync(layout.proceduresDir)).toBe(true);
    expect(fs.existsSync(layout.knowledgeDir)).toBe(true);
    expect(fs.existsSync(layout.rawDir)).toBe(true);
  });

  it('throws with a clear error when AGENT_MEMORY_ROOT is missing', () => {
    expect(() => new AgentMemoryRootService('')).toThrow(
      /AGENT_MEMORY_ROOT is required/,
    );
  });

  it('writes session summaries only under sessions/YYYY/MM/YYYY-MM-DD', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-root-'));
    tempRoots.push(root);

    const service = new AgentMemoryRootService(root);
    const filePath = service.writeSessionSummary({
      groupFolder: 'team-alpha',
      sessionId: 'session-123',
      cause: 'new-session',
      title: 'Session summary',
      markdown: '# Session summary',
      timestamp: new Date('2026-04-10T11:22:33.000Z'),
    });

    expect(filePath).toContain(
      path.join('sessions', '2026', '04', '2026-04-10'),
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

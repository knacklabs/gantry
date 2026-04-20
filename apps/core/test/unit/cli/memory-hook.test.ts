import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runMemoryHookCommand } from '@core/cli/memory-hook.js';
import { logger } from '@core/core/logger.js';

vi.mock('@core/core/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

type MemoryHookServiceMock = {
  ingestGroupSources: ReturnType<typeof vi.fn>;
  ingestGlobalKnowledge: ReturnType<typeof vi.fn>;
  buildBrief: ReturnType<typeof vi.fn>;
  extractFromTranscript: ReturnType<typeof vi.fn>;
};

function createServiceMock(): MemoryHookServiceMock {
  return {
    ingestGroupSources: vi.fn(async () => {}),
    ingestGlobalKnowledge: vi.fn(async () => {}),
    buildBrief: vi.fn(async () => 'brief-content'),
    extractFromTranscript: vi.fn(async () => {}),
  };
}

function createRuntimeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-hook-test-'));
}

function createTranscript(
  runtimeHome: string,
  groupFolder: string,
  sessionId: string,
): string {
  const transcriptPath = path.join(
    runtimeHome,
    'data',
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, '{"type":"user"}\n', 'utf-8');
  return transcriptPath;
}

describe('memory-hook command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs load and returns session-start context output', async () => {
    const service = createServiceMock();
    const env: NodeJS.ProcessEnv = {
      MYCLAW_GROUP_FOLDER: 'team',
      AGENT_ROOT: '/tmp/runtime',
    };
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const code = await runMemoryHookCommand(
        ['load'],
        env,
        async () => ({}),
        async () => service,
      );
      expect(code).toBe(0);
      expect(service.ingestGroupSources).toHaveBeenCalledWith('team');
      expect(service.ingestGlobalKnowledge).toHaveBeenCalled();
      expect(service.buildBrief).toHaveBeenCalledWith({
        groupFolder: 'team',
        maxItems: 20,
        userId: undefined,
      });
      const output = writeSpy.mock.calls
        .map((call) => String(call[0] || ''))
        .join('');
      expect(output).toContain('hookSpecificOutput');
      expect(output).toContain('brief-content');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('extracts on precompact with fallback transcript discovery', async () => {
    const runtimeHome = createRuntimeHome();
    const service = createServiceMock();
    const sessionId = 'session-1';
    const transcriptPath = createTranscript(runtimeHome, 'team', sessionId);
    const env: NodeJS.ProcessEnv = {
      MYCLAW_GROUP_FOLDER: 'team',
      AGENT_ROOT: runtimeHome,
    };

    const code = await runMemoryHookCommand(
      ['extract', '--trigger=precompact'],
      env,
      async () => ({ session_id: sessionId }),
      async () => service,
    );

    expect(code).toBe(0);
    expect(service.extractFromTranscript).toHaveBeenCalledWith({
      transcriptPath: fs.realpathSync(transcriptPath),
      sessionId,
      trigger: 'precompact',
      groupFolder: 'team',
      userId: undefined,
    });
  });

  it('extracts on session-end with explicit transcript path', async () => {
    const runtimeHome = createRuntimeHome();
    const service = createServiceMock();
    const sessionId = 'session-2';
    const transcriptPath = createTranscript(runtimeHome, 'team', sessionId);
    const env: NodeJS.ProcessEnv = {
      MYCLAW_GROUP_FOLDER: 'team',
      AGENT_ROOT: runtimeHome,
    };

    const code = await runMemoryHookCommand(
      ['extract', '--trigger=session-end'],
      env,
      async () => ({
        session_id: sessionId,
        transcript_path: transcriptPath,
      }),
      async () => service,
    );

    expect(code).toBe(0);
    expect(service.extractFromTranscript).toHaveBeenCalledWith({
      transcriptPath: fs.realpathSync(transcriptPath),
      sessionId,
      trigger: 'session-end',
      groupFolder: 'team',
      userId: undefined,
    });
  });

  it('logs warning and skips extract when transcript is missing', async () => {
    const service = createServiceMock();
    const runtimeHome = createRuntimeHome();
    const env: NodeJS.ProcessEnv = {
      MYCLAW_GROUP_FOLDER: 'team',
      AGENT_ROOT: runtimeHome,
    };

    const code = await runMemoryHookCommand(
      ['extract', '--trigger=precompact'],
      env,
      async () => ({ session_id: 'missing-session' }),
      async () => service,
    );

    expect(code).toBe(0);
    expect(service.extractFromTranscript).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'precompact',
        groupFolder: 'team',
        sessionId: 'missing-session',
      }),
      'memory-hook extract skipped: transcript not found',
    );
  });
});

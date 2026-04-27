import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runMemoryHookCommand } from '@core/cli/memory-hook.js';
import { logger } from '@core/infrastructure/logging/logger.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

type MemoryHookServiceMock = {
  isEnabled: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  recordEvidence: ReturnType<typeof vi.fn>;
};

function createServiceMock(): MemoryHookServiceMock {
  return {
    isEnabled: vi.fn(() => true),
    search: vi.fn(async () => [
      {
        item: {
          id: 'mem_1',
          appId: 'default',
          agentId: 'agent:team',
          subjectType: 'group',
          subjectId: 'team',
          kind: 'fact',
          key: 'preference',
          value: 'brief-content',
          confidence: 0.9,
          version: 1,
          evidenceIds: [],
          createdAt: '2026-04-25T00:00:00.000Z',
          updatedAt: '2026-04-25T00:00:00.000Z',
          isPinned: false,
        },
        score: 1,
        lexicalScore: 1,
        vectorScore: null,
        reasons: ['test'],
      },
    ]),
    recordEvidence: vi.fn(async () => ({})),
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
      MYCLAW_HOME: '/tmp/runtime',
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
      expect(service.search).toHaveBeenCalledWith({
        appId: 'default',
        agentId: 'agent:team',
        groupId: 'team',
        query: '',
        limit: 20,
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

  it('infers runtime home and group from hook cwd under agents directory', async () => {
    const runtimeHome = createRuntimeHome();
    const groupFolder = 'telegram_main';
    const agentDir = path.join(runtimeHome, 'agents', groupFolder);
    fs.mkdirSync(agentDir, { recursive: true });
    const service = createServiceMock();
    const env: NodeJS.ProcessEnv = {};
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const code = await runMemoryHookCommand(
        ['load'],
        env,
        async () => ({ cwd: agentDir }),
        async () => service,
      );
      expect(code).toBe(0);
      expect(env.MYCLAW_HOME).toBe(runtimeHome);
      expect(service.search).toHaveBeenCalledWith({
        appId: 'default',
        agentId: `agent:${groupFolder}`,
        groupId: groupFolder,
        query: '',
        limit: 20,
        userId: undefined,
      });
    } finally {
      writeSpy.mockRestore();
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('extracts on precompact with fallback transcript discovery', async () => {
    const runtimeHome = createRuntimeHome();
    const service = createServiceMock();
    const sessionId = 'session-1';
    const transcriptPath = createTranscript(runtimeHome, 'team', sessionId);
    const env: NodeJS.ProcessEnv = {
      MYCLAW_GROUP_FOLDER: 'team',
      MYCLAW_HOME: runtimeHome,
    };

    const code = await runMemoryHookCommand(
      ['extract', '--trigger=precompact'],
      env,
      async () => ({ session_id: sessionId }),
      async () => service,
    );

    expect(code).toBe(0);
    expect(service.recordEvidence).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:team',
      groupId: 'team',
      userId: undefined,
      sourceType: 'session',
      sourceId: sessionId,
      text: '{"type":"user"}',
      metadata: expect.objectContaining({
        transcriptPath: fs.realpathSync(transcriptPath),
        trigger: 'precompact',
        groupFolder: 'team',
      }),
    });
  });

  it('extracts on session-end with explicit transcript path', async () => {
    const runtimeHome = createRuntimeHome();
    const service = createServiceMock();
    const sessionId = 'session-2';
    const transcriptPath = createTranscript(runtimeHome, 'team', sessionId);
    const env: NodeJS.ProcessEnv = {
      MYCLAW_GROUP_FOLDER: 'team',
      MYCLAW_HOME: runtimeHome,
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
    expect(service.recordEvidence).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:team',
      groupId: 'team',
      userId: undefined,
      sourceType: 'session',
      sourceId: sessionId,
      text: '{"type":"user"}',
      metadata: expect.objectContaining({
        transcriptPath: fs.realpathSync(transcriptPath),
        trigger: 'session-end',
        groupFolder: 'team',
      }),
    });
  });

  it('logs warning and skips extract when transcript is missing', async () => {
    const service = createServiceMock();
    const runtimeHome = createRuntimeHome();
    const env: NodeJS.ProcessEnv = {
      MYCLAW_GROUP_FOLDER: 'team',
      MYCLAW_HOME: runtimeHome,
    };

    const code = await runMemoryHookCommand(
      ['extract', '--trigger=precompact'],
      env,
      async () => ({ session_id: 'missing-session' }),
      async () => service,
    );

    expect(code).toBe(0);
    expect(service.recordEvidence).not.toHaveBeenCalled();
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

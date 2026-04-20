import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  isSafeSessionId,
  mapHookCauseToArchiveCause,
  mapHookEventToCause,
  normalizeHookCause,
  parseCauseArg,
  resolveRuntimeFromProjectDir,
  runSessionHook,
} from '@core/bin/session-hook.js';

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe('session hook wrapper', () => {
  it('parses cause from both argv formats', () => {
    expect(parseCauseArg(['--cause', 'session-start'])).toBe('session-start');
    expect(parseCauseArg(['--cause=pre-compact'])).toBe('pre-compact');
    expect(parseCauseArg(['--cause=session-stop'])).toBe('session-stop');
    expect(parseCauseArg(['--cause=unknown'])).toBeUndefined();
  });

  it('normalizes hook causes from raw strings', () => {
    expect(normalizeHookCause(' Session-Start ')).toBe('session-start');
    expect(normalizeHookCause('PRE-COMPACT')).toBe('pre-compact');
    expect(normalizeHookCause('session-stop')).toBe('session-stop');
    expect(normalizeHookCause('bad-value')).toBeUndefined();
  });

  it('maps Claude hook event names to causes', () => {
    expect(mapHookEventToCause('SessionStart')).toBe('session-start');
    expect(mapHookEventToCause('session_start')).toBe('session-start');
    expect(mapHookEventToCause('PreCompact')).toBe('pre-compact');
    expect(mapHookEventToCause('stop')).toBe('session-stop');
    expect(mapHookEventToCause('unknown')).toBeUndefined();
  });

  it('maps wrapper cause to archive cause', () => {
    expect(mapHookCauseToArchiveCause('session-start')).toBe('new-session');
    expect(mapHookCauseToArchiveCause('pre-compact')).toBe('manual-compact');
    expect(mapHookCauseToArchiveCause('session-stop')).toBe(
      'abandoned-session',
    );
  });

  it('validates session ids used by hooks', () => {
    expect(isSafeSessionId('sess-001')).toBe(true);
    expect(isSafeSessionId('session_2026.04.19')).toBe(true);
    expect(isSafeSessionId('../escape')).toBe(false);
    expect(isSafeSessionId('bad/slash')).toBe(false);
  });

  it('resolves runtime home and group folder from CLAUDE_PROJECT_DIR', () => {
    const runtimeHome = path.join('/tmp', 'myclaw-home');
    const projectDir = path.join(
      runtimeHome,
      'data',
      'sessions',
      'team-alpha',
      '.claude',
      'projects',
      'workspace-group',
    );

    expect(resolveRuntimeFromProjectDir(projectDir)).toEqual({
      runtimeHome,
      groupFolder: 'team-alpha',
    });
    expect(resolveRuntimeFromProjectDir('/tmp/not-a-session-path')).toEqual({});
  });

  it('derives context from hook env and archives transcript', async () => {
    const archiveSessionTranscript = vi.fn();
    const loadArchiveModule = vi.fn(async () => ({
      archiveSessionTranscript,
    }));
    const runtimeHome = path.join('/tmp', 'myclaw-runtime');
    const env = makeEnv({
      CLAUDE_HOOK_EVENT: 'SessionStart',
      CLAUDE_SESSION_ID: 'sess-001',
      CLAUDE_PROJECT_DIR: path.join(
        runtimeHome,
        'data',
        'sessions',
        'team-main',
        '.claude',
        'projects',
        'workspace-group',
      ),
    });

    await runSessionHook({
      env,
      loadArchiveModule,
    });

    expect(env.AGENT_ROOT).toBe(runtimeHome);
    expect(loadArchiveModule).toHaveBeenCalledTimes(1);
    expect(archiveSessionTranscript).toHaveBeenCalledWith({
      groupFolder: 'team-main',
      sessionId: 'sess-001',
      cause: 'new-session',
      writePlaceholderOnMissing: false,
    });
  });

  it('prefers explicit MYCLAW_GROUP_FOLDER over project-derived group', async () => {
    const archiveSessionTranscript = vi.fn();
    const runtimeHome = path.join('/tmp', 'myclaw-runtime');
    const env = makeEnv({
      CLAUDE_SESSION_ID: 'sess-002',
      CLAUDE_PROJECT_DIR: path.join(
        runtimeHome,
        'data',
        'sessions',
        'project-group',
        '.claude',
        'projects',
        'workspace-group',
      ),
      MYCLAW_GROUP_FOLDER: 'explicit-group',
    });

    await runSessionHook({
      argv: ['--cause=session-stop'],
      env,
      loadArchiveModule: async () => ({ archiveSessionTranscript }),
    });

    expect(archiveSessionTranscript).toHaveBeenCalledWith({
      groupFolder: 'explicit-group',
      sessionId: 'sess-002',
      cause: 'abandoned-session',
      writePlaceholderOnMissing: false,
    });
  });

  it('no-ops when required fields are missing', async () => {
    const loadArchiveModule = vi.fn(async () => ({
      archiveSessionTranscript: vi.fn(),
    }));

    await runSessionHook({
      argv: ['--cause=session-start'],
      env: makeEnv({}),
      loadArchiveModule,
    });

    expect(loadArchiveModule).not.toHaveBeenCalled();
  });

  it('swallows archive module load failures', async () => {
    await expect(
      runSessionHook({
        argv: ['--cause=session-start'],
        env: makeEnv({
          CLAUDE_SESSION_ID: 'sess-003',
          MYCLAW_GROUP_FOLDER: 'team',
        }),
        loadArchiveModule: async () => {
          throw new Error('load failure');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('ignores invalid group folder and session id values', async () => {
    const loadArchiveModule = vi.fn(async () => ({
      archiveSessionTranscript: vi.fn(),
    }));

    await runSessionHook({
      argv: ['--cause=session-start'],
      env: makeEnv({
        CLAUDE_SESSION_ID: '../bad',
        MYCLAW_GROUP_FOLDER: '../group',
      }),
      loadArchiveModule,
    });

    expect(loadArchiveModule).not.toHaveBeenCalled();
  });
});

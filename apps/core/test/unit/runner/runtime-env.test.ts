import path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

async function loadRuntimeEnv(): Promise<
  typeof import('@core/adapters/llm/anthropic-claude-agent/runner/runtime-env.js')
> {
  vi.resetModules();
  process.env.GANTRY_WORKSPACE_GROUP_DIR = '/tmp/gantry/group';
  process.env.GANTRY_WORKSPACE_EXTRA_DIR = '/tmp/gantry/extra';
  process.env.GANTRY_IPC_DIR = '/tmp/gantry/ipc';
  process.env.GANTRY_IPC_INPUT_DIR = '/tmp/gantry/ipc/input';
  return import('@core/adapters/llm/anthropic-claude-agent/runner/runtime-env.js');
}

describe('Anthropic runner runtime env', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('resolves the Gantry MCP stdio server from the built adapter runner path', async () => {
    const { resolveMcpServerPath } = await loadRuntimeEnv();
    const runnerIndex = pathToFileURL(
      '/tmp/gantry/dist/adapters/llm/anthropic-claude-agent/runner/index.js',
    ).href;

    expect(resolveMcpServerPath(runnerIndex)).toBe(
      path.normalize('/tmp/gantry/dist/runner/mcp/stdio.js'),
    );
  });

  it('resolves the Gantry MCP stdio server from the source adapter runner path', async () => {
    const { resolveMcpServerPath } = await loadRuntimeEnv();
    const runnerIndex = pathToFileURL(
      '/tmp/gantry/apps/core/src/adapters/llm/anthropic-claude-agent/runner/index.ts',
    ).href;

    expect(resolveMcpServerPath(runnerIndex)).toBe(
      path.normalize('/tmp/gantry/apps/core/src/runner/mcp/stdio.js'),
    );
  });

  it('suppresses Claude SDK-native skills without removing Gantry skill config', async () => {
    const configDirEnvKey = ['CLAUDE', 'CONFIG', 'DIR'].join('_');
    process.env[configDirEnvKey] = '/tmp/gantry/claude-config';
    const { buildSdkEnv } = await loadRuntimeEnv();

    const sdkEnv = buildSdkEnv();

    expect(sdkEnv[configDirEnvKey]).toBe('/tmp/gantry/claude-config');
    expect(sdkEnv.CLAUDE_CODE_DISABLE_POLICY_SKILLS).toBe('1');
    expect(sdkEnv.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL).toBe('1');
  });

  it('keeps SDK no-proxy loopback-only so external hosts pass through Gantry egress', async () => {
    process.env.NO_PROXY = 'api.github.com,corp.internal,127.0.0.1';
    process.env.no_proxy = 'lower.internal,localhost';
    const { buildSdkEnv } = await loadRuntimeEnv();

    const sdkEnv = buildSdkEnv();
    const noProxy = sdkEnv.NO_PROXY?.split(',') ?? [];

    expect(noProxy).toEqual(
      expect.arrayContaining(['127.0.0.1', 'localhost', '::1']),
    );
    expect(sdkEnv.no_proxy).toBe(sdkEnv.NO_PROXY);
    expect(noProxy).not.toContain('api.github.com');
    expect(noProxy).not.toContain('.github.com');
    expect(noProxy).not.toContain('corp.internal');
    expect(noProxy).not.toContain('lower.internal');
  });

  it('does not pass local CLI credential identity env to the SDK runner', async () => {
    process.env.HOME = '/Users/tester';
    process.env.USERPROFILE = '/Users/tester';
    process.env.XDG_CONFIG_HOME = '/Users/tester/.config';
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local';
    process.env.USER = 'tester';
    process.env.USERNAME = 'tester';
    process.env.LOGNAME = 'tester';
    const { buildSdkEnv } = await loadRuntimeEnv();

    const sdkEnv = buildSdkEnv();

    expect(sdkEnv.HOME).toBeUndefined();
    expect(sdkEnv.USERPROFILE).toBeUndefined();
    expect(sdkEnv.XDG_CONFIG_HOME).toBeUndefined();
    expect(sdkEnv.APPDATA).toBeUndefined();
    expect(sdkEnv.LOCALAPPDATA).toBeUndefined();
    expect(sdkEnv.USER).toBeUndefined();
    expect(sdkEnv.USERNAME).toBeUndefined();
    expect(sdkEnv.LOGNAME).toBeUndefined();
  });
});

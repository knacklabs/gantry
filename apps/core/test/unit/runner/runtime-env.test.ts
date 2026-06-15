import fs from 'fs';
import os from 'os';
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

  it('uses sandbox-runtime proxy values visible inside the sandbox', async () => {
    process.env.GANTRY_SANDBOX_RUNTIME_PROXY = '1';
    process.env.HTTP_PROXY = 'http://localhost:3128';
    process.env.HTTPS_PROXY = 'http://localhost:3128';
    process.env.ALL_PROXY = 'socks5h://localhost:3129';
    process.env.GRPC_PROXY = 'socks5h://localhost:3129';
    process.env.NO_PROXY = '127.0.0.1,localhost,::1';
    const { buildEffectiveToolNetworkEnv, buildSdkEnv } =
      await loadRuntimeEnv();

    const sdkEnv = buildSdkEnv({
      [['ANTHROPIC', 'BASE', 'URL'].join('_')]:
        'http://127.0.0.1:4567/anthropic',
    });
    const toolEnv = buildEffectiveToolNetworkEnv({
      HTTP_PROXY: 'http://127.0.0.1:18080/',
      HTTPS_PROXY: 'http://127.0.0.1:18080/',
      NO_PROXY: '127.0.0.1,localhost,::1',
    });

    expect(sdkEnv.HTTP_PROXY).toBe('http://localhost:3128');
    expect(sdkEnv.HTTPS_PROXY).toBe('http://localhost:3128');
    expect(sdkEnv.CLAUDE_CODE_API_BASE_URL).toBe(
      'http://127.0.0.1:4567/anthropic',
    );
    expect(sdkEnv.DISABLE_TELEMETRY).toBe('1');
    expect(sdkEnv.CLAUDE_CODE_BYOC_ENABLE_DATADOG).toBe('0');
    expect(sdkEnv.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES).toBe('0');
    expect(sdkEnv.CLAUDE_CODE_PROXY_RESOLVES_HOSTS).toBe('1');
    expect(sdkEnv.GODEBUG).toBe('netdns=go');
    expect(sdkEnv.NO_PROXY).toBe('');
    expect(toolEnv.HTTP_PROXY).toBe('http://localhost:3128');
    expect(toolEnv.HTTPS_PROXY).toBe('http://localhost:3128');
    expect(toolEnv.CLAUDE_CODE_API_BASE_URL).toBeUndefined();
    expect(toolEnv.DISABLE_TELEMETRY).toBeUndefined();
    expect(toolEnv.CLAUDE_CODE_PROXY_RESOLVES_HOSTS).toBe('1');
    expect(toolEnv.ALL_PROXY).toBe('socks5h://localhost:3129');
    expect(toolEnv.GRPC_PROXY).toBe('socks5h://localhost:3129');
    expect(toolEnv.GODEBUG).toBe('netdns=go');
    expect(toolEnv.NO_PROXY).toBe('');
    expect(toolEnv.no_proxy).toBe('');
  });

  it('marks the Claude Code child as already sandboxed in sandbox-runtime mode', async () => {
    process.env.GANTRY_SANDBOX_RUNTIME_PROXY = '1';
    const { buildSdkEnv } = await loadRuntimeEnv();

    const sdkEnv = buildSdkEnv();

    expect(sdkEnv.CLAUDE_CODE_SANDBOXED).toBe('1');
  });

  it('does not apply sandbox-runtime SDK direct egress guards outside sandbox mode', async () => {
    const { buildSdkEnv } = await loadRuntimeEnv();

    const sdkEnv = buildSdkEnv({
      [['ANTHROPIC', 'BASE', 'URL'].join('_')]:
        'http://127.0.0.1:4567/anthropic',
    });

    expect(sdkEnv.CLAUDE_CODE_API_BASE_URL).toBeUndefined();
    expect(sdkEnv.DISABLE_TELEMETRY).toBeUndefined();
    expect(sdkEnv.CLAUDE_CODE_BYOC_ENABLE_DATADOG).toBeUndefined();
    expect(sdkEnv.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES).toBeUndefined();
  });

  it('rejects proxy env in model credentials', async () => {
    const { buildSdkEnv } = await loadRuntimeEnv();

    expect(() =>
      buildSdkEnv({ HTTP_PROXY: 'http://127.0.0.1:18080/' }),
    ).toThrow('modelCredentialEnv.HTTP_PROXY is not supported.');
  });

  it('rejects raw Claude Code OAuth tokens in model credentials', async () => {
    const { buildSdkEnv } = await loadRuntimeEnv();
    const oauthEnvKey = ['CLAUDE', 'CODE', 'OAUTH', 'TOKEN'].join('_');

    expect(() =>
      buildSdkEnv({
        [oauthEnvKey]: 'sk-ant-oat-test',
      }),
    ).toThrow(`modelCredentialEnv.${oauthEnvKey} is not supported.`);
  });

  it('resolves Claude Code executable from PATH when present', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-claude-bin-'));
    const executable = path.join(binDir, 'claude');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    fs.chmodSync(executable, 0o700);
    try {
      const { resolveClaudeCodeExecutableFromPath } = await loadRuntimeEnv();

      expect(resolveClaudeCodeExecutableFromPath(binDir)).toBe(
        fs.realpathSync(executable),
      );
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('allows host-installed Claude Code from the standard local install root', async () => {
    process.env.HOME = '/Users/tester';
    const { allowedOuterSandboxClaudeExecutable } = await loadRuntimeEnv();

    expect(
      allowedOuterSandboxClaudeExecutable(
        '/Users/tester/.local/share/claude/versions/2.1.162',
      ),
    ).toBe('/Users/tester/.local/share/claude/versions/2.1.162');
    expect(
      allowedOuterSandboxClaudeExecutable('/Users/tester/.ssh/claude'),
    ).toBeUndefined();
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

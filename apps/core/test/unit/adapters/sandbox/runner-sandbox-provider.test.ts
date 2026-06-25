import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DirectRunnerSandboxProvider,
  buildSandboxRuntimeWarmTemplate,
  createRunnerSandboxProvider,
} from '@core/adapters/sandbox/runner-sandbox-provider.js';

const mockChildKill = vi.hoisted(() => vi.fn(() => true));

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn(() =>
      Object.assign(new EventEmitter(), {
        stdin: {},
        stdout: {},
        stderr: {},
        pid: 1234,
        kill: mockChildKill,
      }),
    ),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const baseInput = {
  command: '/usr/bin/node',
  args: ['runner.js'],
  cwd: '/work/agent',
  workspaceRoot: '/work/agent',
  configFilePath: '/work/agent/.gantry/sandbox.json',
  egressProxyUrl: 'http://127.0.0.1:18789',
  allowedNetworkHosts: ['api.example.com:443'],
  runtimeReadPaths: ['/work/agent/runtime'],
  runtimeWritePaths: ['/work/agent/ipc'],
  env: { PATH: '/usr/bin' },
  protectedReadPaths: ['/work/agent/.secret'],
  protectedWritePaths: ['/work/agent/.secret'],
  resourceLimits: {
    cpuSeconds: 0,
    memoryMb: 0,
    maxProcesses: 0,
  },
  sandboxProfile: {
    id: 'runner-default',
    network: 'required',
    filesystem: 'workspace_write',
  },
  principal: {
    appId: 'default',
    agentId: 'main',
  },
} as const;

describe('runner sandbox provider', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
    mockChildKill.mockClear();
  });

  it('keeps direct execution in the sandbox adapter', () => {
    const provider = new DirectRunnerSandboxProvider();

    expect(provider.warmTemplate()).toEqual({
      available: false,
      cacheHit: false,
      authorityFree: true,
    });

    provider.start(baseInput);

    expect(spawn).toHaveBeenCalledWith('/usr/bin/node', ['runner.js'], {
      cwd: '/work/agent',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin' },
      detached: true,
    });
  });

  it('keeps the sandbox-runtime warm template authority-free', () => {
    const provider = createRunnerSandboxProvider({
      provider: 'sandbox_runtime',
      resourceLimits: {
        cpuSeconds: 0,
        memoryMb: 0,
        maxProcesses: 0,
      },
    });

    const status = provider.warmTemplate?.();
    const cachedStatus = provider.warmTemplate?.();
    const template = buildSandboxRuntimeWarmTemplate();
    const serialized = JSON.stringify(template);

    expect(status).toMatchObject({
      available: true,
      authorityFree: true,
    });
    expect(cachedStatus).toMatchObject({
      available: true,
      cacheHit: true,
      authorityFree: true,
    });
    expect(template.authorityFree).toBe(true);
    expect(template.network).toEqual({
      deniedDomains: [],
      allowLocalBinding: false,
    });
    for (const forbidden of [
      '/work/agent',
      'api.example.com',
      '127.0.0.1',
      '18789',
      'GANTRY',
      'API_KEY',
      'TOKEN',
      'credentialRef',
      'transient',
      'grant',
      'lease',
      'mcp',
      'browser',
      'session',
      'workspace',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('wraps runner execution with sandbox runtime config', () => {
    const provider = createRunnerSandboxProvider({
      provider: 'sandbox_runtime',
      resourceLimits: {
        cpuSeconds: 30,
        memoryMb: 1024,
        maxProcesses: 24,
      },
    });

    const child = provider.start({
      ...baseInput,
      resourceLimits: {
        cpuSeconds: 30,
        memoryMb: 1024,
        maxProcesses: 24,
      },
    });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/work/agent/.gantry/sandbox.json',
      expect.stringContaining('"parentProxy"'),
      { mode: 0o600 },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/work/agent/.gantry/sandbox.json',
      expect.stringContaining('"api.example.com"'),
      { mode: 0o600 },
    );
    const config = JSON.parse(
      String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]),
    );
    expect(config.network.httpProxyPort).toBeUndefined();
    expect(config.network.socksProxyPort).toBeUndefined();
    expect(config.network.parentProxy).toEqual({
      http: 'http://127.0.0.1:18789',
      https: 'http://127.0.0.1:18789',
      noProxy: '',
    });
    expect(config.network.allowLocalBinding).toBe(false);
    expect(config.filesystem.denyRead).not.toContain('/');
    expect(config.filesystem.denyRead).toContain('/work');
    expect(config.filesystem.denyRead).toContain('/work/agent/.secret');
    expect(config.filesystem.denyRead).toContain(pathInHome('.ssh'));
    expect(config.filesystem.denyRead).toContain(pathInHome('.aws'));
    expect(config.filesystem.denyRead).toContain(pathInHome('.claude'));
    expect(config.filesystem.denyRead).toContain(pathInHome('.config/gh'));
    expect(config.filesystem.denyRead).toContain(pathInHome('gantry/.env'));
    expect(config.filesystem.denyRead).toContain('/work/agent/.env');
    expect(config.filesystem.denyWrite).toContain('/tmp/claude');
    expect(config.filesystem.denyWrite).toContain('/private/tmp/claude');
    expect(config.filesystem.denyWrite).toContain(pathInHome('gantry/.env'));
    expect(config.filesystem.denyWrite).toContain(pathInHome('.claude/debug'));
    expect(config.filesystem.denyWrite).toContain('/work/agent/.env');
    expect(config.filesystem.allowRead).toContain(process.execPath);
    expect(config.filesystem.allowRead).not.toContain('/work/agent');
    expect(config.filesystem.allowRead).not.toContain('/work/agent/*');
    expect(config.filesystem.allowRead).not.toContain('/work/agent/runtime');
    if (process.platform === 'darwin') {
      expect(config.filesystem.allowWrite).toContain(
        `/private/tmp/claude-${process.getuid?.() ?? 0}`,
      );
    }
    expect(config.filesystem.allowRead).not.toContain('/work/agent/.secret');
    if (process.platform === 'darwin') {
      expect(config.enableWeakerNetworkIsolation).toBe(true);
    } else {
      expect(config.enableWeakerNetworkIsolation).toBeUndefined();
    }
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringMatching(/sandbox-runtime\/dist\/cli\.js$/),
        '--settings',
        '/work/agent/.gantry/sandbox.json',
      ]),
      expect.objectContaining({
        cwd: '/work/agent',
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      }),
    );
    (child as unknown as { emit(name: string): void }).emit('exit');
  });

  it('allows required executable paths while denying sibling runtime reads', () => {
    const provider = createRunnerSandboxProvider({
      provider: 'sandbox_runtime',
      resourceLimits: {
        cpuSeconds: 0,
        memoryMb: 0,
        maxProcesses: 0,
      },
    });

    provider.start({
      ...baseInput,
      command: '/opt/acme/bin/acme',
      args: ['records', 'get'],
    });

    const config = JSON.parse(
      String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]),
    );
    expect(config.filesystem.denyRead).toContain('/work');
    expect(config.filesystem.allowRead).toContain(process.execPath);
    expect(config.filesystem.allowRead).not.toContain('/work/agent');
    expect(config.filesystem.denyRead).toContain('/work/agent/.secret');
    expect(config.filesystem.denyRead).toContain(pathInHome('.gnupg'));
    expect(config.filesystem.denyRead).toContain(
      pathInHome('.config/github-copilot'),
    );
  });

  it('preserves IPv4 literals and omits unsupported IPv6 literals', () => {
    const provider = createRunnerSandboxProvider({
      provider: 'sandbox_runtime',
      resourceLimits: {
        cpuSeconds: 0,
        memoryMb: 0,
        maxProcesses: 0,
      },
    });

    provider.start({
      ...baseInput,
      allowedNetworkHosts: [
        'api.example.com:443',
        '93.184.216.34:443',
        '[2606:2800:220:1:248:1893:25c8:1946]:443',
      ],
    });

    const config = JSON.parse(
      String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]),
    );
    expect(config.network.allowedDomains).toEqual([
      '93.184.216.34',
      'api.example.com',
    ]);
  });

  it('preserves approved single-label network hosts', () => {
    const provider = createRunnerSandboxProvider({
      provider: 'sandbox_runtime',
      resourceLimits: {
        cpuSeconds: 0,
        memoryMb: 0,
        maxProcesses: 0,
      },
    });

    provider.start({
      ...baseInput,
      allowedNetworkHosts: ['registry:443', 'Corp-Proxy:8443'],
    });

    const config = JSON.parse(
      String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]),
    );
    expect(config.network.allowedDomains).toEqual(['corp-proxy', 'registry']);
  });

  it('keeps deny-read paths narrow so generic macOS tools can start', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const workspace = actualFs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-sandbox-workspace-'),
    );
    const runtime = path.join(workspace, 'runtime');
    const protectedDir = path.join(workspace, 'protected');
    const sourceDir = path.join(workspace, 'src');
    actualFs.mkdirSync(runtime);
    actualFs.mkdirSync(protectedDir);
    actualFs.mkdirSync(sourceDir);
    actualFs.writeFileSync(path.join(workspace, '.env'), 'SECRET=1');
    actualFs.writeFileSync(path.join(runtime, '.env'), 'SECRET=1');
    actualFs.writeFileSync(path.join(protectedDir, 'token.txt'), 'SECRET=1');
    actualFs.writeFileSync(path.join(sourceDir, 'index.ts'), 'console.log(1)');

    const provider = createRunnerSandboxProvider({
      provider: 'sandbox_runtime',
      resourceLimits: {
        cpuSeconds: 0,
        memoryMb: 0,
        maxProcesses: 0,
      },
    });

    provider.start({
      ...baseInput,
      cwd: workspace,
      workspaceRoot: workspace,
      runtimeReadPaths: [runtime],
      protectedReadPaths: [protectedDir],
    });

    const config = JSON.parse(
      String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]),
    );
    expect(config.filesystem.denyRead).toContain(path.join(workspace, '.env'));
    expect(config.filesystem.denyRead).toContain(path.join(runtime, '.env'));
    expect(config.filesystem.denyRead).toContain(protectedDir);
    expect(config.filesystem.denyRead).not.toContain(path.dirname(workspace));
    expect(config.filesystem.allowRead).not.toContain(workspace);
    expect(config.filesystem.allowRead).not.toContain(
      path.join(workspace, '*'),
    );
    expect(config.filesystem.allowRead).not.toContain(runtime);
    if (process.platform === 'darwin') {
      expect(config.filesystem.allowRead).toContain(
        macosExactPathPattern(runtime),
      );
    }
    expect(config.filesystem.allowRead).toContain(sourceDir);
    expect(config.filesystem.allowRead).not.toContain(protectedDir);
    expect(config.filesystem.allowRead).not.toContain(
      path.join(protectedDir, 'token.txt'),
    );
  });

  it('kills the sandbox-runtime process group', () => {
    const processKill = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true);
    const provider = createRunnerSandboxProvider({
      provider: 'sandbox_runtime',
      resourceLimits: {
        cpuSeconds: 0,
        memoryMb: 0,
        maxProcesses: 0,
      },
    });

    const child = provider.start(baseInput);
    child.kill('SIGKILL');

    expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(mockChildKill).not.toHaveBeenCalled();
    (child as unknown as { emit(name: string): void }).emit('exit');
    processKill.mockRestore();
  });
});

function pathInHome(relativePath: string): string {
  return `${os.homedir()}/${relativePath}`;
}

function macosExactPathPattern(targetPath: string): string {
  const basename = path.basename(targetPath);
  return path.join(
    path.dirname(targetPath),
    `${basename.slice(0, -1)}[${basename.slice(-1)}]`,
  );
}

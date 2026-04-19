import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
}));

describe('host-capabilities', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it('prefers gws and includes explicit Gmail readiness checks', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'onecli') return '/usr/bin/onecli';
      if (command === 'which' && args[0] === 'gws') return '/usr/bin/gws';
      throw new Error('not found');
    });

    const mod = await import('./host-capabilities.js');
    const capability = mod.detectGoogleWorkspaceCli();
    const text = mod.buildGoogleWorkspaceCapabilityPromptText();
    const combined = mod.buildHostCapabilityPromptText();

    expect(capability).toEqual({ command: 'gws', onecliInstalled: true });
    expect(text).toContain('onecli exec -- gws auth status');
    expect(text).toContain('gws auth login');
    expect(text).toContain('onecli exec -- gws gmail users profile get');
    expect(text).toContain('onecli exec -- gws gmail users messages list');
    expect(combined).toContain('mcp__myclaw__fast_lookup');
  });

  it('falls back to direct gws commands when onecli is unavailable', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'gws') return '/usr/bin/gws';
      throw new Error('not found');
    });

    const mod = await import('./host-capabilities.js');
    const text = mod.buildGoogleWorkspaceCapabilityPromptText();

    expect(text).toContain('`gws auth status`');
    expect(text).toContain('`gws gmail users profile get');
    expect(text).toContain('`gws gmail users messages list');
  });

  it('uses direct commands when settings disable onecli wrapping', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'onecli') return '/usr/bin/onecli';
      if (command === 'which' && args[0] === 'gws') return '/usr/bin/gws';
      throw new Error('not found');
    });

    const mod = await import('./host-capabilities.js');
    const text = mod.buildGoogleWorkspaceCapabilityPromptText({
      mode: 'on',
      command: 'gws',
      useOnecli: false,
    });

    expect(text).toContain('`gws auth status`');
    expect(text).not.toContain('onecli exec -- gws');
  });

  it('does not expose Google Workspace guidance when capability is turned off', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'onecli') return '/usr/bin/onecli';
      if (command === 'which' && args[0] === 'gws') return '/usr/bin/gws';
      throw new Error('not found');
    });

    const mod = await import('./host-capabilities.js');
    const text = mod.buildGoogleWorkspaceCapabilityPromptText({
      mode: 'off',
      command: 'gws',
      useOnecli: true,
    });
    const env = mod.buildGoogleWorkspaceCliEnv(
      {},
      {
        mode: 'off',
        command: 'gws',
        useOnecli: true,
      },
    );

    expect(text).toBe('');
    expect(env).toEqual({});
  });

  it('caches explicit CLI detection for VM-style command settings', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'onecli') return '/usr/bin/onecli';
      if (command === 'which' && args[0] === 'gws') return '/usr/bin/gws';
      throw new Error('not found');
    });

    const mod = await import('./host-capabilities.js');
    expect(
      mod.detectGoogleWorkspaceCli({
        mode: 'on',
        command: 'gws',
        useOnecli: true,
      }),
    ).toEqual({ command: 'gws', onecliInstalled: true });
    expect(
      mod.detectGoogleWorkspaceCli({
        mode: 'on',
        command: 'gws',
        useOnecli: true,
      }),
    ).toEqual({ command: 'gws', onecliInstalled: true });

    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('always includes fast lookup CLI guidance for quick current-info questions', async () => {
    const mod = await import('./host-capabilities.js');
    const text = mod.buildFastLookupCapabilityPromptText();

    expect(text).toContain(
      'start with the MyClaw MCP tool `mcp__myclaw__fast_lookup`',
    );
    expect(text).toContain('sports');
    expect(text).toContain('quick web results');
    expect(text).toContain('failed `WebSearch` attempt');
    expect(text).toContain('use `WebFetch`');
    expect(text).toContain('mcp__myclaw__fast_lookup');
    expect(text).toContain('Use mode `lookup`');
    expect(text).toContain('which tool failed');
  });

  it('provides stable gws env defaults for headless runtime access', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'gws') return '/usr/bin/gws';
      throw new Error('not found');
    });
    mockExistsSync.mockImplementation(
      (filePath: string) => filePath === '/etc/ssl/cert.pem',
    );

    const mod = await import('./host-capabilities.js');
    const env = mod.buildGoogleWorkspaceCliEnv({});

    expect(env).toEqual({
      GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'file',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
    });
  });

  it('does not override caller-provided gws env settings', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'gws') return '/usr/bin/gws';
      throw new Error('not found');
    });

    const mod = await import('./host-capabilities.js');
    const env = mod.buildGoogleWorkspaceCliEnv({
      GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'keyring',
      SSL_CERT_FILE: '/custom/certs.pem',
    });

    expect(env).toEqual({});
  });
});

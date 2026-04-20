import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Top-level mocks for modules that must be intercepted before the   */
/*  source module is imported (OneCLI is instantiated at module scope) */
/* ------------------------------------------------------------------ */

const mockGetContainerConfig = vi.fn();

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: function OneCLI() {
    return {
      getContainerConfig: mockGetContainerConfig,
    };
  },
}));

const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('fs', () => ({
  default: {
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
}));

const mockLoggerWarn = vi.fn();

vi.mock('@core/core/logger.js', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const mockEnsureGroupIpcLayout = vi.fn();
const mockEnsureSharedSessionSettings = vi.fn();
const mockSyncGroupSkills = vi.fn();
const mockGetHostAgentRunnerRoot = vi.fn(
  () => '/tmp/myclaw-test/packages/agent-runner',
);

vi.mock('@core/runtime/agent-spawn-layout.js', () => ({
  ensureGroupIpcLayout: (...args: unknown[]) =>
    mockEnsureGroupIpcLayout(...args),
  ensureSharedSessionSettings: (...args: unknown[]) =>
    mockEnsureSharedSessionSettings(...args),
  syncGroupSkills: (...args: unknown[]) => mockSyncGroupSkills(...args),
  getHostAgentRunnerRoot: () => mockGetHostAgentRunnerRoot(),
}));

/* ------------------------------------------------------------------ */
/*  Helper: dynamic import with config overrides                      */
/* ------------------------------------------------------------------ */

async function loadModule(config: {
  ONECLI_URL?: string;
  DATA_DIR?: string;
  AGENTS_DIR?: string;
  AGENT_ROOT?: string;
  envFromFile?: Record<string, string>;
}) {
  vi.resetModules();

  // Re-register top-level mocks that resetModules clears.
  // Must use `function` (not arrow) so it is callable with `new`.
  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: function OneCLI() {
      return { getContainerConfig: mockGetContainerConfig };
    },
  }));

  vi.doMock('fs', () => ({
    default: {
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
    },
  }));

  vi.doMock('@core/core/logger.js', () => ({
    logger: {
      warn: (...args: unknown[]) => mockLoggerWarn(...args),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.doMock('@core/runtime/agent-spawn-layout.js', () => ({
    ensureGroupIpcLayout: (...args: unknown[]) =>
      mockEnsureGroupIpcLayout(...args),
    ensureSharedSessionSettings: (...args: unknown[]) =>
      mockEnsureSharedSessionSettings(...args),
    syncGroupSkills: (...args: unknown[]) => mockSyncGroupSkills(...args),
    getHostAgentRunnerRoot: () => mockGetHostAgentRunnerRoot(),
  }));

  vi.doMock('@core/core/config.js', () => ({
    ONECLI_URL: config.ONECLI_URL ?? '',
    DATA_DIR: config.DATA_DIR ?? '/tmp/myclaw-test/data',
    AGENTS_DIR: config.AGENTS_DIR ?? '/tmp/myclaw-test/agents',
    AGENT_ROOT: config.AGENT_ROOT ?? '/tmp/myclaw-test/config',
  }));

  vi.doMock('@core/core/env.js', () => ({
    readEnvFile: (keys: string[]) => {
      const source = config.envFromFile ?? {};
      return keys.reduce<Record<string, string>>((acc, key) => {
        const value = source[key];
        if (typeof value === 'string') {
          acc[key] = value;
        }
        return acc;
      }, {});
    },
  }));

  vi.doMock('@core/platform/group-folder.js', () => ({
    resolveGroupFolderPath: (folder: string) =>
      `${config.AGENTS_DIR ?? '/tmp/myclaw-test/agents'}/${folder}`,
    resolveGroupIpcPath: (folder: string) =>
      `${config.DATA_DIR ?? '/tmp/myclaw-test/data'}/ipc/${folder}`,
  }));

  return import('@core/runtime/agent-spawn-host.js');
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                         */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

/* ================================================================== */
/*  getHostRuntimeCredentialEnv                                       */
/* ================================================================== */

describe('getHostRuntimeCredentialEnv', () => {
  it('returns env from file only when ONECLI_URL is not set', async () => {
    const mod = await loadModule({
      ONECLI_URL: '',
      envFromFile: { ANTHROPIC_API_KEY: 'sk-file-key' },
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(false);
    expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'sk-file-key' });
    expect(result.onecliCaPath).toBeUndefined();
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('returns env from file only when ONECLI_URL is whitespace', async () => {
    const mod = await loadModule({
      ONECLI_URL: '   ',
      envFromFile: { ANTHROPIC_MODEL: 'opus' },
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(false);
    expect(result.env).toEqual({ ANTHROPIC_MODEL: 'opus' });
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('uses env-only mode even when ONECLI_URL is configured', async () => {
    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: {
        MYCLAW_CREDENTIAL_MODE: 'env-only',
        ANTHROPIC_API_KEY: 'sk-file-key',
      },
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(false);
    expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'sk-file-key' });
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('uses onecli-only mode without file env fallback', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'onecli-token',
      },
    });
    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: {
        MYCLAW_CREDENTIAL_MODE: 'onecli-only',
        ANTHROPIC_API_KEY: 'sk-file-key',
      },
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(true);
    expect(result.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'onecli-token',
    });
  });

  it('throws when onecli-only mode is set but ONECLI_URL is missing', async () => {
    const mod = await loadModule({
      ONECLI_URL: '',
      envFromFile: {
        MYCLAW_CREDENTIAL_MODE: 'onecli-only',
      },
    });

    await expect(mod.getHostRuntimeCredentialEnv()).rejects.toThrow(
      'ONECLI_URL is not configured',
    );
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('merges OneCLI env when gateway succeeds without CA cert', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: { ANTHROPIC_AUTH_TOKEN: 'onecli-token' },
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: { ANTHROPIC_API_KEY: 'sk-file-key' },
    });

    const result = await mod.getHostRuntimeCredentialEnv('my-agent');

    expect(result.onecliApplied).toBe(true);
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-file-key',
      ANTHROPIC_AUTH_TOKEN: 'onecli-token',
    });
    expect(result.onecliCaPath).toBeUndefined();
    expect(mockGetContainerConfig).toHaveBeenCalledWith('my-agent');
  });

  it('writes CA certificate and returns onecliCaPath when present', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: { ANTHROPIC_AUTH_TOKEN: 'token' },
      caCertificate:
        '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
      caCertificateContainerPath: '/etc/ssl/onecli/ca.pem',
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(true);
    expect(result.onecliCaPath).toBe(
      '/tmp/myclaw-test/data/onecli/certs/default.pem',
    );
    expect(result.env.NODE_EXTRA_CA_CERTS).toBe(
      '/tmp/myclaw-test/data/onecli/certs/default.pem',
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/tmp/myclaw-test/data/onecli/certs',
      {
        recursive: true,
        mode: 0o700,
      },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/myclaw-test/data/onecli/certs/default.pem',
      '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
      { mode: 0o600 },
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedPath: '/etc/ssl/onecli/ca.pem',
        targetPath: '/tmp/myclaw-test/data/onecli/certs/default.pem',
      }),
      'Remapped OneCLI CA certificate path outside runtime data directory',
    );
  });

  it('keeps requested CA path when it is under runtime data dir', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: { ANTHROPIC_AUTH_TOKEN: 'token' },
      caCertificate: 'cert-data',
      caCertificateContainerPath:
        '/tmp/myclaw-test/data/onecli/certs/custom.pem',
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
    });

    const result = await mod.getHostRuntimeCredentialEnv('agent-x');

    expect(result.onecliApplied).toBe(true);
    expect(result.onecliCaPath).toBe(
      '/tmp/myclaw-test/data/onecli/certs/custom.pem',
    );
    expect(result.env.NODE_EXTRA_CA_CERTS).toBe(
      '/tmp/myclaw-test/data/onecli/certs/custom.pem',
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/tmp/myclaw-test/data/onecli/certs',
      {
        recursive: true,
        mode: 0o700,
      },
    );
  });

  it('remaps OneCLI env values pointing at the requested CA path', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'token',
        SSL_CERT_FILE: '/etc/ssl/onecli/ca.pem',
      },
      caCertificate: 'cert-data',
      caCertificateContainerPath: '/etc/ssl/onecli/ca.pem',
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.env.SSL_CERT_FILE).toBe(
      '/tmp/myclaw-test/data/onecli/certs/default.pem',
    );
  });

  it('logs warning and omits onecliCaPath when CA cert write fails', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: { ANTHROPIC_AUTH_TOKEN: 'token' },
      caCertificate: 'cert-data',
      caCertificateContainerPath: '/readonly/ca.pem',
    });
    mockMkdirSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(true);
    expect(result.onecliCaPath).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        certificatePath: '/tmp/myclaw-test/data/onecli/certs/default.pem',
      }),
      'Failed to write OneCLI CA certificate',
    );
  });

  it('logs warning and returns file env when OneCLI gateway throws', async () => {
    mockGetContainerConfig.mockRejectedValue(new Error('ECONNREFUSED'));

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: { ANTHROPIC_API_KEY: 'sk-fallback' },
    });

    const result = await mod.getHostRuntimeCredentialEnv('agent-x');

    expect(result.onecliApplied).toBe(false);
    expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'sk-fallback' });
    expect(result.onecliCaPath).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agentIdentifier: 'agent-x' }),
      'OneCLI gateway not reachable',
    );
  });

  it('throws when onecli-only mode cannot reach OneCLI gateway', async () => {
    mockGetContainerConfig.mockRejectedValue(new Error('ECONNREFUSED'));

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: {
        MYCLAW_CREDENTIAL_MODE: 'onecli-only',
      },
    });

    await expect(mod.getHostRuntimeCredentialEnv()).rejects.toThrow(
      'OneCLI gateway is not reachable',
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agentIdentifier: 'default' }),
      'OneCLI gateway not reachable',
    );
  });

  it('uses "default" as agentIdentifier in warning when none provided', async () => {
    mockGetContainerConfig.mockRejectedValue(new Error('ECONNREFUSED'));

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
    });

    await mod.getHostRuntimeCredentialEnv();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agentIdentifier: 'default' }),
      'OneCLI gateway not reachable',
    );
  });

  it('OneCLI env overrides file env for overlapping keys', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_API_KEY: 'onecli-key-wins',
        ANTHROPIC_BASE_URL: 'https://onecli.example.com',
      },
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: {
        ANTHROPIC_API_KEY: 'file-key-loses',
        ANTHROPIC_MODEL: 'sonnet',
      },
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.env.ANTHROPIC_API_KEY).toBe('onecli-key-wins');
    expect(result.env.ANTHROPIC_BASE_URL).toBe('https://onecli.example.com');
    expect(result.env.ANTHROPIC_MODEL).toBe('sonnet');
    expect(result.onecliApplied).toBe(true);
  });
});

/* ================================================================== */
/*  prepareHostRuntimeContext                                         */
/* ================================================================== */

describe('prepareHostRuntimeContext', () => {
  const fakeGroup = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@bot',
    added_at: '2025-01-01T00:00:00Z',
  };

  it('creates group dir, calls layout functions, and returns context', async () => {
    mockExistsSync.mockReturnValue(false);

    const mod = await loadModule({
      AGENTS_DIR: '/tmp/myclaw-test/agents',
      DATA_DIR: '/tmp/myclaw-test/data',
    });

    const ctx = mod.prepareHostRuntimeContext(fakeGroup);

    expect(ctx.groupDir).toBe('/tmp/myclaw-test/agents/test-group');
    expect(ctx.groupIpcDir).toBe('/tmp/myclaw-test/data/ipc/test-group');
    expect(ctx.runnerRoot).toBe('/tmp/myclaw-test/packages/agent-runner');

    // Verify mkdirSync was called for the group directory
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/tmp/myclaw-test/agents/test-group',
      { recursive: true },
    );

    // Verify layout helpers were called
    expect(mockEnsureSharedSessionSettings).toHaveBeenCalled();
    expect(mockSyncGroupSkills).toHaveBeenCalled();
    expect(mockGetHostAgentRunnerRoot).toHaveBeenCalled();
    expect(mockEnsureGroupIpcLayout).toHaveBeenCalledWith(
      '/tmp/myclaw-test/data/ipc/test-group',
    );
  });

  it('returns globalDir when shared directory exists', async () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === '/tmp/myclaw-test/agents/shared',
    );

    const mod = await loadModule({
      AGENTS_DIR: '/tmp/myclaw-test/agents',
      DATA_DIR: '/tmp/myclaw-test/data',
    });

    const ctx = mod.prepareHostRuntimeContext(fakeGroup);

    expect(ctx.globalDir).toBe('/tmp/myclaw-test/agents/shared');
  });

  it('returns undefined globalDir when shared directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const mod = await loadModule({
      AGENTS_DIR: '/tmp/myclaw-test/agents',
      DATA_DIR: '/tmp/myclaw-test/data',
    });

    const ctx = mod.prepareHostRuntimeContext(fakeGroup);

    expect(ctx.globalDir).toBeUndefined();
  });
});

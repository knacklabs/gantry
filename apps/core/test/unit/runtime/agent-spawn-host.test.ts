import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetContainerConfig = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockRenameSync = vi.fn();
const mockChmodSync = vi.fn();
const mockRmSync = vi.fn();
const mockExistsSync = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockEnsureGroupIpcLayout = vi.fn();
const mockEnsureSharedSessionSettings = vi.fn();
const mockSyncGroupSkills = vi.fn();
const mockGetHostAgentRunnerDistDir = vi.fn(
  () => '/tmp/myclaw-test/dist/runner',
);

async function loadModule(config: {
  ONECLI_URL?: string;
  DATA_DIR?: string;
  AGENTS_DIR?: string;
  MYCLAW_HOME?: string;
  MYCLAW_CREDENTIAL_MODE?: string;
}) {
  vi.resetModules();

  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: function OneCLI() {
      return { getContainerConfig: mockGetContainerConfig };
    },
  }));

  vi.doMock('fs', () => ({
    default: {
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      renameSync: (...args: unknown[]) => mockRenameSync(...args),
      chmodSync: (...args: unknown[]) => mockChmodSync(...args),
      rmSync: (...args: unknown[]) => mockRmSync(...args),
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      realpathSync: (value: string) => value,
      lstatSync: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
    },
  }));

  vi.doMock('@core/infrastructure/logging/logger.js', () => ({
    logger: {
      warn: (...args: unknown[]) => mockLoggerWarn(...args),
      info: (...args: unknown[]) => mockLoggerInfo(...args),
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
    getHostAgentRunnerDistDir: () => mockGetHostAgentRunnerDistDir(),
  }));

  vi.doMock('@core/config/index.js', () => ({
    ONECLI_URL: config.ONECLI_URL ?? 'http://localhost:10254',
    ONECLI_BROKER_URL: config.ONECLI_URL ?? 'http://localhost:10254',
    EXTERNAL_BROKER_BASE_URL: '',
    DATA_DIR: config.DATA_DIR ?? '/tmp/myclaw-test/data',
    AGENTS_DIR: config.AGENTS_DIR ?? '/tmp/myclaw-test/agents',
    MYCLAW_HOME: config.MYCLAW_HOME ?? '/tmp/myclaw-test/config',
    MYCLAW_CREDENTIAL_MODE: config.MYCLAW_CREDENTIAL_MODE ?? 'onecli',
    getCredentialBrokerRuntimeConfig: () => ({
      mode: config.MYCLAW_CREDENTIAL_MODE ?? 'onecli',
      onecliUrl: config.ONECLI_URL ?? 'http://localhost:10254',
      externalBrokerBaseUrl: '',
    }),
    ONECLI_ALLOWED_ENV_KEYS: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
  }));
  vi.doMock('@core/config/env/index.js', () => ({
    envConfig: {
      ONECLI_URL: config.ONECLI_URL ?? 'http://localhost:10254',
      MYCLAW_CREDENTIAL_MODE: config.MYCLAW_CREDENTIAL_MODE ?? 'onecli',
    },
    envValue: (key: string) =>
      ({
        ONECLI_URL: config.ONECLI_URL ?? 'http://localhost:10254',
        MYCLAW_CREDENTIAL_MODE: config.MYCLAW_CREDENTIAL_MODE ?? 'onecli',
      })[key] || '',
  }));

  return import('@core/runtime/agent-spawn-host.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMkdirSync.mockImplementation(() => undefined);
  mockWriteFileSync.mockImplementation(() => undefined);
  mockRenameSync.mockImplementation(() => undefined);
  mockChmodSync.mockImplementation(() => undefined);
  mockRmSync.mockImplementation(() => undefined);
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  vi.resetModules();
});

describe('getHostRuntimeCredentialEnv', () => {
  it('requires ONECLI_URL in broker-first mode', async () => {
    const mod = await loadModule({ ONECLI_URL: '' });

    await expect(mod.getHostRuntimeCredentialEnv()).rejects.toThrow(
      'ONECLI_URL is not configured',
    );
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('returns broker env and never reads local raw provider credentials', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        CUSTOM_FLAG: 'ignored',
      },
    });
    const mod = await loadModule({});

    const result = await mod.getHostRuntimeCredentialEnv('agent-x');

    expect(result).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      brokerApplied: true,
      brokerProfile: 'onecli',
    });
    expect(mockGetContainerConfig).toHaveBeenCalledWith('agent-x');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      {
        droppedKeys: ['CUSTOM_FLAG'],
        droppedCount: 1,
      },
      'Dropped disallowed OneCLI env keys',
    );
  });

  it('allows OneCLI broker proxy env and drops host CA env keys', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        ANTHROPIC_API_KEY: 'placeholder',
        HTTPS_PROXY: 'http://x:aoc_123@host.docker.internal:10255',
        NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
      },
    });
    const mod = await loadModule({});

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://broker.example.com',
      ANTHROPIC_API_KEY: 'placeholder',
      HTTPS_PROXY: 'http://x:aoc_123@127.0.0.1:10255/',
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      {
        droppedKeys: ['NODE_EXTRA_CA_CERTS'],
        droppedCount: 1,
      },
      'Dropped disallowed OneCLI env keys',
    );
  });

  it('fails closed when OneCLI returns a raw credential key', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-secret',
      },
    });
    const mod = await loadModule({});

    await expect(mod.getHostRuntimeCredentialEnv()).rejects.toThrow(
      'forbidden raw credential env key: ANTHROPIC_API_KEY',
    );
  });

  it('applies OneCLI CA certificates to the host runner trust roots', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      caCertificate: 'cert-data',
      caCertificateContainerPath: '/etc/ssl/onecli/ca.pem',
    });
    const mod = await loadModule({});

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.brokerApplied).toBe(true);
    expect(result.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://broker.example.com',
      NODE_EXTRA_CA_CERTS:
        '/tmp/myclaw-test/data/onecli/gateway-ca-37a8eec1ce19687d.pem',
    });
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/myclaw-test/data/onecli', {
      recursive: true,
      mode: 0o700,
    });
    expect(mockChmodSync).toHaveBeenCalledWith(
      '/tmp/myclaw-test/data/onecli',
      0o700,
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/tmp\/myclaw-test\/data\/onecli\/gateway-ca-37a8eec1ce19687d\.pem\.\d+\.[0-9a-f-]+\.tmp$/,
      ),
      'cert-data',
      { mode: 0o600 },
    );
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/tmp\/myclaw-test\/data\/onecli\/gateway-ca-37a8eec1ce19687d\.pem\.\d+\.[0-9a-f-]+\.tmp$/,
      ),
      '/tmp/myclaw-test/data/onecli/gateway-ca-37a8eec1ce19687d.pem',
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      {
        agentIdentifier: 'default',
        caPath: '/tmp/myclaw-test/data/onecli/gateway-ca-37a8eec1ce19687d.pem',
      },
      'Applied OneCLI CA certificate for host runner',
    );
  });

  it('rejects untrusted non-loopback http OneCLI URLs', async () => {
    const mod = await loadModule({ ONECLI_URL: 'http://onecli.example.com' });

    await expect(mod.getHostRuntimeCredentialEnv()).rejects.toThrow(
      'ONECLI_URL must use HTTPS unless it points to loopback',
    );
  });
});

describe('prepareHostRuntimeContext', () => {
  const fakeGroup = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@bot',
    added_at: '2025-01-01T00:00:00Z',
  };

  it('creates group dir, calls layout functions, and returns context', async () => {
    const mod = await loadModule({});

    const ctx = mod.prepareHostRuntimeContext(fakeGroup);

    expect(ctx.groupDir).toBe('/tmp/myclaw-test/agents/test-group');
    expect(ctx.groupIpcDir).toBe('/tmp/myclaw-test/data/ipc/test-group');
    expect(ctx.runnerDistDir).toBe('/tmp/myclaw-test/dist/runner');
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/tmp/myclaw-test/agents/test-group',
      { recursive: true },
    );
    expect(mockEnsureSharedSessionSettings).toHaveBeenCalled();
    expect(mockSyncGroupSkills).toHaveBeenCalled();
    expect(mockGetHostAgentRunnerDistDir).toHaveBeenCalled();
    expect(mockEnsureGroupIpcLayout).toHaveBeenCalledWith(
      '/tmp/myclaw-test/data/ipc/test-group',
    );
  });

  it('returns globalDir when shared directory exists', async () => {
    mockExistsSync.mockImplementation(
      (value: string) => value === '/tmp/myclaw-test/agents/shared',
    );
    const mod = await loadModule({});

    const ctx = mod.prepareHostRuntimeContext(fakeGroup);

    expect(ctx.globalDir).toBe('/tmp/myclaw-test/agents/shared');
  });
});

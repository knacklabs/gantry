import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const getContainerConfig = vi.hoisted(() => vi.fn());
const ensureAgent = vi.hoisted(() => vi.fn());

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: vi.fn(function () {
    return {
      getContainerConfig,
      ensureAgent,
    };
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('OnecliAgentCredentialBroker', () => {
  it('returns broker-safe injection env and materializes certificate refs', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-onecli-'));
    getContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        HTTPS_PROXY:
          'http://x:aoc_104f2fa6600ede448b527c267a13d6a0db0dad62b3f9ca087446cc8e15acd697@host.docker.internal:10255',
        GIT_TERMINAL_PROMPT: '0',
        NODE_EXTRA_CA_CERTS: '/container/ca.pem',
      },
      caCertificate: 'cert-data',
    });

    const { OnecliAgentCredentialBroker } =
      await import('@core/adapters/credentials/onecli/broker.js');
    const broker = new OnecliAgentCredentialBroker({
      onecliUrl: 'http://localhost:10254',
      dataDir,
    });

    const injection = await broker.getInjection({
      binding: {
        profile: 'onecli',
        agentIdentifier: 'agent-a',
      },
    });
    const caPath = path.join(
      dataDir,
      'onecli',
      'gateway-ca-a51d7389ba2cb760.pem',
    );

    expect(getContainerConfig).toHaveBeenCalledWith('agent-a');
    expect(injection).toMatchObject({
      applied: true,
      brokerProfile: 'onecli',
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        HTTPS_PROXY:
          'http://x:aoc_104f2fa6600ede448b527c267a13d6a0db0dad62b3f9ca087446cc8e15acd697@127.0.0.1:10255/',
        NODE_EXTRA_CA_CERTS: caPath,
      },
      proxy: {
        https:
          'http://x:aoc_104f2fa6600ede448b527c267a13d6a0db0dad62b3f9ca087446cc8e15acd697@127.0.0.1:10255/',
      },
      certificates: {
        nodeExtraCaCertsPath: caPath,
      },
    });
    expect(fs.readFileSync(caPath, 'utf-8')).toBe('cert-data');
    expect(fs.statSync(path.join(dataDir, 'onecli')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(caPath).mode & 0o777).toBe(0o600);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not cache credential-bearing container config by default', async () => {
    getContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      },
    });

    const { OnecliAgentCredentialBroker } =
      await import('@core/adapters/credentials/onecli/broker.js');
    const broker = new OnecliAgentCredentialBroker({
      onecliUrl: 'http://localhost:10254',
      dataDir: os.tmpdir(),
    });

    await broker.getInjection({
      binding: { profile: 'onecli', agentIdentifier: 'agent-a' },
    });
    await broker.getInjection({
      binding: { profile: 'onecli', agentIdentifier: 'agent-a' },
    });

    expect(getContainerConfig).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent container config requests by agent', async () => {
    let resolveConfig!: (config: { env: Record<string, string> }) => void;
    getContainerConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );

    const { OnecliAgentCredentialBroker } =
      await import('@core/adapters/credentials/onecli/broker.js');
    const broker = new OnecliAgentCredentialBroker({
      onecliUrl: 'http://localhost:10254',
      dataDir: os.tmpdir(),
    });

    const first = broker.getInjection({
      binding: { profile: 'onecli', agentIdentifier: 'agent-a' },
    });
    const second = broker.getInjection({
      binding: { profile: 'onecli', agentIdentifier: 'agent-a' },
    });
    resolveConfig({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      },
    });
    await Promise.all([first, second]);

    expect(getContainerConfig).toHaveBeenCalledTimes(1);
  });

  it('can cache container config by agent when an explicit TTL is configured', async () => {
    getContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      },
    });

    const { OnecliAgentCredentialBroker } =
      await import('@core/adapters/credentials/onecli/broker.js');
    const broker = new OnecliAgentCredentialBroker({
      onecliUrl: 'http://localhost:10254',
      dataDir: os.tmpdir(),
      configCacheTtlMs: 30_000,
    });

    await broker.getInjection({
      binding: { profile: 'onecli', agentIdentifier: 'agent-a' },
    });
    await broker.getInjection({
      binding: { profile: 'onecli', agentIdentifier: 'agent-a' },
    });

    expect(getContainerConfig).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite unchanged CA certificate material for the same agent', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-onecli-'));
    getContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      },
      caCertificate: 'cert-data',
    });

    const { OnecliAgentCredentialBroker } =
      await import('@core/adapters/credentials/onecli/broker.js');
    const broker = new OnecliAgentCredentialBroker({
      onecliUrl: 'http://localhost:10254',
      dataDir,
      configCacheTtlMs: 0,
    });

    await broker.getInjection({
      binding: { profile: 'onecli', agentIdentifier: 'agent-a' },
    });
    const caPath = path.join(
      dataDir,
      'onecli',
      'gateway-ca-a51d7389ba2cb760.pem',
    );
    const firstMtimeMs = fs.statSync(caPath).mtimeMs;
    await broker.getInjection({
      binding: { profile: 'onecli', agentIdentifier: 'agent-a' },
    });

    expect(fs.statSync(caPath).mtimeMs).toBe(firstMtimeMs);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fails closed when OneCLI returns raw runtime or provider secrets', async () => {
    getContainerConfig.mockResolvedValue({
      env: {
        MYCLAW_DATABASE_URL: 'postgres://runtime-secret',
      },
    });

    const { OnecliAgentCredentialBroker } =
      await import('@core/adapters/credentials/onecli/broker.js');
    const broker = new OnecliAgentCredentialBroker({
      onecliUrl: 'http://localhost:10254',
      dataDir: os.tmpdir(),
    });

    await expect(
      broker.getInjection({ binding: { profile: 'onecli' } }),
    ).rejects.toThrow(/MYCLAW_DATABASE_URL/);
  });

  it('fails closed when OneCLI returns a non-local model proxy env', async () => {
    getContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        HTTPS_PROXY: 'http://proxy.example.com:8080',
      },
    });

    const { OnecliAgentCredentialBroker } =
      await import('@core/adapters/credentials/onecli/broker.js');
    const broker = new OnecliAgentCredentialBroker({
      onecliUrl: 'http://localhost:10254',
      dataDir: os.tmpdir(),
    });

    await expect(
      broker.getInjection({ binding: { profile: 'onecli' } }),
    ).rejects.toThrow(/forbidden raw credential env value.*HTTPS_PROXY/);
  });
});

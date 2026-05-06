import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
const getContainerConfigMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: vi.fn(function OneCLI() {
    return {
      getContainerConfig: getContainerConfigMock,
    };
  }),
}));

describe('runClaudeQuery', () => {
  let runtimeRoot = '';

  function writeCredentialSettings(
    mode: 'none' | 'onecli' | 'external',
    externalBaseUrl = '',
  ): void {
    fs.writeFileSync(
      path.join(runtimeRoot, 'settings.yaml'),
      [
        'providers: {}',
        'storage:',
        '  postgres:',
        '    url_env: MYCLAW_DATABASE_URL',
        '    schema: myclaw',
        'credential_broker:',
        `  mode: ${mode}`,
        '  onecli:',
        '    url: http://localhost:10254',
        '  external:',
        `    base_url: "${externalBaseUrl}"`,
        'memory:',
        '  enabled: true',
        '  embeddings:',
        '    enabled: false',
        '    provider: disabled',
        '    model: text-embedding-3-large',
        '  dreaming:',
        '    enabled: false',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  beforeEach(() => {
    vi.resetModules();
    runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-claude-query-'),
    );
    writeCredentialSettings('onecli');
    vi.stubEnv('MYCLAW_HOME', runtimeRoot);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    queryMock.mockReset();
    getContainerConfigMock.mockReset();
    getContainerConfigMock.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        CUSTOM_FLAG: 'ignored',
      },
    });
  });

  afterEach(() => {
    if (runtimeRoot) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      runtimeRoot = '';
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('passes only broker-safe OneCLI env into SDK query env', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"kind":"fact"}]' }],
          },
        };
      })(),
    );

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');
    await runClaudeQuery({
      model: 'claude-haiku-4-5-20251001',
      prompt: 'Extract facts',
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(getContainerConfigMock).toHaveBeenCalledWith('myclaw-model-access');
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          prompt?: string;
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.prompt).toBe('Extract facts');
    expect(call?.options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
  });

  it('scrubs ambient raw provider credentials from SDK query env', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-ambient');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-ambient');
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"kind":"fact"}]' }],
          },
        };
      })(),
    );

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');
    await runClaudeQuery({
      model: 'claude-haiku-4-5-20251001',
      prompt: 'Extract facts',
    });

    const call = queryMock.mock.calls[0]?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
  });

  it('fails closed when OneCLI returns raw provider credentials', async () => {
    getContainerConfigMock.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        ANTHROPIC_API_KEY: 'must-not-reach-sdk-env',
      },
    });

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');

    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).rejects.toThrow(/forbidden raw credential env key: ANTHROPIC_API_KEY/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('drops container-local certificate paths returned by OneCLI', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"kind":"fact"}]' }],
          },
        };
      })(),
    );
    getContainerConfigMock.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
        NODE_EXTRA_CA_CERTS: '/tmp/onecli-ca.pem',
      },
    });

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');

    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).resolves.toBe('[{"kind":"fact"}]');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
  });

  it('does not treat leftover ONECLI_URL as auth in none mode', async () => {
    writeCredentialSettings('none');
    vi.stubEnv('ONECLI_URL', 'http://localhost:10254');

    const { hasClaudeAuthConfigured, runClaudeQuery } =
      await import('@core/memory/claude-query.js');

    expect(hasClaudeAuthConfigured()).toBe(false);
    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).rejects.toThrow('Claude auth is not configured');
    expect(getContainerConfigMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('does not treat model-only external mode as configured auth', async () => {
    writeCredentialSettings('external');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');

    const { hasClaudeAuthConfigured, runClaudeQuery } =
      await import('@core/memory/claude-query.js');

    expect(hasClaudeAuthConfigured()).toBe(false);
    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).rejects.toThrow('Claude auth is not configured');
    expect(getContainerConfigMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows external mode when a broker endpoint is configured', async () => {
    writeCredentialSettings('external', 'https://broker.local/anthropic');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"kind":"fact"}]' }],
          },
        };
      })(),
    );

    const { hasClaudeAuthConfigured, runClaudeQuery } =
      await import('@core/memory/claude-query.js');

    expect(hasClaudeAuthConfigured()).toBe(true);
    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).resolves.toBe('[{"kind":"fact"}]');
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
    expect(getContainerConfigMock).not.toHaveBeenCalled();
  });

  it('uses settings before ambient env for memory credential mode and does not read model from env', async () => {
    writeCredentialSettings('external', 'https://broker.local/anthropic');
    vi.resetModules();
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'none');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"kind":"fact"}]' }],
          },
        };
      })(),
    );

    const { hasClaudeAuthConfigured, runClaudeQuery } =
      await import('@core/memory/claude-query.js');

    expect(hasClaudeAuthConfigured()).toBe(true);
    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).resolves.toBe('[{"kind":"fact"}]');
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
    expect(getContainerConfigMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe external broker endpoints before memory SDK queries', async () => {
    writeCredentialSettings(
      'external',
      'https://user:pass@broker.local/anthropic',
    );

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');

    await expect(
      runClaudeQuery({
        model: 'claude-haiku-4-5-20251001',
        prompt: 'Extract facts',
      }),
    ).rejects.toThrow(
      'credential_broker.external.base_url must not contain embedded credentials',
    );
    expect(queryMock).not.toHaveBeenCalled();
    expect(getContainerConfigMock).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

import { AnthropicClaudeAgentExecutionAdapter } from '@core/adapters/llm/anthropic-claude-agent/execution-adapter.js';
import type { AgentExecutionAdapterPrepareInput } from '@core/application/agent-execution/agent-execution-adapter.js';
import {
  type ModelCatalogEntry,
  resolveModelSelection,
} from '@core/shared/model-catalog.js';
import fs from 'fs';

const mockMaterializeClaudeRuntime = vi.hoisted(() =>
  vi.fn(async () => ({
    claudeConfigDir: '/tmp/gantry-runtime/.claude',
    protectedFilesystemPaths: ['/tmp/gantry-runtime/.claude'],
    cleanup: vi.fn(),
  })),
);

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
    },
  };
});

vi.mock(
  '@core/adapters/llm/anthropic-claude-agent/claude-config-materializer.js',
  () => ({
    materializeClaudeRuntime: mockMaterializeClaudeRuntime,
    projectClaudeModelCredentialEnv: (env: Record<string, string>) => env,
  }),
);

function prepareInput(
  patch: Partial<AgentExecutionAdapterPrepareInput> = {},
): AgentExecutionAdapterPrepareInput {
  return {
    group: {
      name: 'Test Agent',
      folder: 'test-agent',
      added_at: '2026-05-19T00:00:00.000Z',
    },
    input: {
      prompt: 'hello',
      chatJid: 'tg:test',
    },
    hostRuntime: {
      groupDir: '/tmp/gantry/agents/test-agent',
      groupIpcDir: '/tmp/gantry/ipc/test-agent',
      runnerDistDir: '/opt/gantry/dist/runner',
    },
    groupDir: '/tmp/gantry/agents/test-agent',
    effectiveModel: 'claude-sonnet-4-5',
    modelCredentialProjection: {
      env: {},
      credentialProviders: {},
      brokerProfile: 'none',
      brokerApplied: false,
    },
    browserIpcEnabled: false,
    packageRootFromRunner: () => '/opt/gantry',
    ...patch,
  };
}

const anthropicBaseUrlKey = () => 'ANTHROPIC' + '_BASE_URL';
const claudeCodeOAuthTokenKey = () =>
  ['CLAUDE', 'CODE', 'OAUTH', 'TOKEN'].join('_');
function catalogEntry(alias: string): ModelCatalogEntry {
  const resolved = resolveModelSelection(alias);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.entry;
}

describe('AnthropicClaudeAgentExecutionAdapter', () => {
  it('passes the host-validated Gantry MCP server path to the relocated runner', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(prepared.env.GANTRY_MCP_SERVER_PATH).toBe(
      '/opt/gantry/dist/runner/mcp/stdio.js',
    );
  });

  it('keeps Claude config in a stable session store', async () => {
    mockMaterializeClaudeRuntime.mockClear();
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await adapter.prepare(prepareInput());

    const materializeInput = mockMaterializeClaudeRuntime.mock.calls[0]?.[0];
    expect(materializeInput).toMatchObject({
      baseTempDir: '/tmp/gantry/agents/test-agent/.llm-runtime',
      cleanupPolicy: 'retain-for-debug',
    });
  });

  it('declares Claude runtime paths through the adapter boundary', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(prepared.runtimeConfigDir).toBe('/tmp/gantry-runtime/.claude');
    expect(prepared.sandboxRuntime?.toolTempDirLeaf).toMatch(/^claude/);
    expect(prepared.sandboxRuntime?.tempEnv?.('/tmp/runner')).toEqual({
      CLAUDE_CODE_TMPDIR: '/tmp/runner',
      CLAUDE_TMPDIR: '/tmp/runner',
    });
  });

  it('classifies stale Claude SDK resume sessions inside the adapter boundary', () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    expect(
      adapter.isMissingProviderSessionError(
        'No conversation found with session ID: stale',
      ),
    ).toBe(true);
    expect(adapter.isMissingProviderSessionError('provider auth failed')).toBe(
      false,
    );
  });

  it('passes only materialized Gantry skill names to the runner SDK whitelist', async () => {
    mockMaterializeClaudeRuntime.mockResolvedValueOnce({
      claudeConfigDir: '/tmp/gantry-runtime/.claude',
      protectedFilesystemPaths: ['/tmp/gantry-runtime/.claude'],
      materializedSkills: [
        { name: 'gantry-admin', materializedName: 'gantry-admin' },
        { name: 'LinkedIn Posting', materializedName: 'LinkedIn-Posting' },
      ],
      cleanup: vi.fn(),
    });
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(prepared.env.GANTRY_CLAUDE_SDK_SKILLS_JSON).toBe(
      JSON.stringify(['LinkedIn-Posting', 'gantry-admin']),
    );
  });

  it('rejects materialized skill names that collide with Claude-native skills', async () => {
    mockMaterializeClaudeRuntime.mockResolvedValueOnce({
      claudeConfigDir: '/tmp/gantry-runtime/.claude',
      protectedFilesystemPaths: ['/tmp/gantry-runtime/.claude'],
      materializedSkills: [{ name: 'commands', materializedName: 'commands' }],
      cleanup: vi.fn(),
    });
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(adapter.prepare(prepareInput())).rejects.toThrow(
      'Claude-native reserved names',
    );
  });

  it('passes only selected skill ids to Claude runtime materialization', async () => {
    mockMaterializeClaudeRuntime.mockClear();
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await adapter.prepare(
      prepareInput({
        browserIpcEnabled: true,
        input: {
          prompt: 'hello',
          chatJid: 'tg:test',
          attachedSkillSourceIds: ['skill:release'],
        },
      }),
    );

    expect(mockMaterializeClaudeRuntime.mock.calls[0]?.[0]).toMatchObject({
      enabledSkillIds: ['gantry-browser', 'skill:release'],
    });
  });

  it('passes an empty SDK skill allowlist when no skills are selected', async () => {
    mockMaterializeClaudeRuntime.mockClear();
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(mockMaterializeClaudeRuntime.mock.calls[0]?.[0]).toMatchObject({
      enabledSkillIds: [],
    });
    expect(prepared.env.GANTRY_CLAUDE_SDK_SKILLS_JSON).toBe('[]');
  });

  it('fails when runner files are missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(adapter.prepare(prepareInput())).rejects.toThrow(
      'missing required Anthropic execution adapter runner files',
    );
  });

  it('fails when OpenRouter model credentials are missing', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('kimi'),
            displayName: 'Kimi',
            runnerModel: 'openrouter/kimi',
          },
        }),
      ),
    ).rejects.toThrow('requires Gantry Model Gateway credentials');
  });

  it('allows Gantry gateway projections for OpenRouter models', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('kimi'),
            displayName: 'Kimi',
            runnerModel: 'openrouter/kimi',
          },
          modelCredentialProjection: {
            env: Object.fromEntries([
              [anthropicBaseUrlKey(), 'http://127.0.0.1:4567/openrouter'],
              ['ANTHROPIC_API_KEY', 'gtw_test'],
              ['ANTHROPIC_AUTH_TOKEN', 'gtw_test'],
            ]),
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('fails when Anthropic model credentials are missing', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
        }),
      ),
    ).rejects.toThrow('requires Gantry Model Gateway credentials');
  });

  it('allows Gantry gateway projections for Anthropic models', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: Object.fromEntries([
              [anthropicBaseUrlKey(), 'http://127.0.0.1:4567/anthropic'],
              ['ANTHROPIC_API_KEY', 'gtw_test'],
            ]),
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects raw Claude Code OAuth projections for Anthropic models', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: {
              [claudeCodeOAuthTokenKey()]: 'sk-ant-oat-test',
            },
            credentialProviders: {
              [claudeCodeOAuthTokenKey()]: 'native',
            },
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).rejects.toThrow('must not expose provider OAuth tokens');
  });

  it('allows IPv6 loopback Gantry gateway projections', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: Object.fromEntries([
              [anthropicBaseUrlKey(), 'http://[::1]:4567/anthropic'],
              [['ANTHROPIC', 'API_KEY'].join('_'), 'gtw_test'],
            ]),
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects non-loopback gateway credentials for provider models', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: { ANTHROPIC_BASE_URL: 'https://api.openrouter.ai./v1' },
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).rejects.toThrow('must use a loopback ANTHROPIC_BASE_URL');
  });

  it('rejects runner paths outside the package root', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          packageRootFromRunner: () => '/opt/other-package',
        }),
      ),
    ).rejects.toThrow('runner path escaped the Gantry package root');
  });
});

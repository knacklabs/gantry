import { describe, expect, it, vi } from 'vitest';

import { AnthropicClaudeAgentExecutionAdapter } from '@core/adapters/llm/anthropic-claude-agent/execution-adapter.js';
import type { AgentExecutionAdapterPrepareInput } from '@core/application/agent-execution/agent-execution-adapter.js';
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
    applyOpenRouterSdkEnv: vi.fn(),
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

describe('AnthropicClaudeAgentExecutionAdapter', () => {
  it('passes the host-validated Gantry MCP server path to the relocated runner', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(prepared.env.GANTRY_MCP_SERVER_PATH).toBe(
      '/opt/gantry/dist/runner/mcp/stdio.js',
    );
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
            alias: 'kimi',
            provider: 'openrouter',
            providerLabel: 'OpenRouter',
            displayName: 'Kimi',
            runnerModel: 'openrouter/kimi',
          },
        }),
      ),
    ).rejects.toThrow('requires an OpenRouter-scoped credential');
  });

  it('rejects OpenRouter-scoped credentials for non-OpenRouter models', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            alias: 'sonnet',
            provider: 'anthropic',
            providerLabel: 'Anthropic',
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: { ANTHROPIC_BASE_URL: 'https://api.openrouter.ai./v1' },
            credentialProviders: {},
            brokerProfile: 'onecli',
            brokerApplied: true,
          },
        }),
      ),
    ).rejects.toThrow('returned OpenRouter-scoped Anthropic SDK credentials');
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

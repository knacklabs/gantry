import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';

import { DeepAgentsLangChainExecutionAdapter } from '@core/adapters/llm/deepagents-langchain/execution-adapter.js';
import type { AgentExecutionAdapterPrepareInput } from '@core/application/agent-execution/agent-execution-adapter.js';
import {
  type ModelCatalogEntry,
  resolveModelSelection,
} from '@core/shared/model-catalog.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    },
  };
});

const openAiBaseUrlKey = () => 'OPENAI' + '_BASE_URL';
const openAiApiKeyKey = () => 'OPENAI' + '_API_KEY';
const claudeCodeOAuthTokenKey = () =>
  ['CLAUDE', 'CODE', 'OAUTH', 'TOKEN'].join('_');

function catalogEntry(alias: string): ModelCatalogEntry {
  const resolved = resolveModelSelection(alias);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.entry;
}

function prepareInput(
  patch: Partial<AgentExecutionAdapterPrepareInput> = {},
): AgentExecutionAdapterPrepareInput {
  return {
    group: {
      name: 'Test Agent',
      folder: 'test-agent',
      added_at: '2026-06-12T00:00:00.000Z',
    },
    input: {
      prompt: 'hello',
      chatJid: 'tg:test',
    },
    hostRuntime: {
      groupDir: '/tmp/gantry/agents/test-agent',
      workspaceIpcDir: '/tmp/gantry/ipc/test-agent',
      runnerDistDir: '/opt/gantry/dist/runner',
    },
    groupDir: '/tmp/gantry/agents/test-agent',
    effectiveModel: 'gpt-5.5',
    effectiveModelEntry: catalogEntry('gpt'),
    modelCredentialProjection: {
      env: Object.fromEntries([
        [openAiBaseUrlKey(), 'http://127.0.0.1:4567/openai'],
        [openAiApiKeyKey(), 'gtw_test'],
      ]),
      credentialProviders: {},
      brokerProfile: 'gantry',
      brokerApplied: true,
      brokerAuthMode: 'api_key',
    },
    browserIpcEnabled: false,
    packageRootFromRunner: () => '/opt/gantry',
    ...patch,
  };
}

describe('DeepAgentsLangChainExecutionAdapter', () => {
  it('declares the deepagents:langchain execution provider id', () => {
    expect(new DeepAgentsLangChainExecutionAdapter().id).toBe(
      'deepagents:langchain',
    );
  });

  it('resolves the relocated deepagents runner under the dist tree', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    const prepared = await adapter.prepare(prepareInput());
    expect(prepared.runnerPath).toBe(
      '/opt/gantry/dist/adapters/llm/deepagents-langchain/runner/index.js',
    );
    expect(prepared.runnerArgs).toEqual([prepared.runnerPath]);
    expect(prepared.providerId).toBe('deepagents:langchain');
  });

  it('projects only the gateway model credential env to the runner', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    const prepared = await adapter.prepare(prepareInput());
    expect(prepared.runnerInputPatch?.modelCredentialEnv).toEqual({
      [openAiBaseUrlKey()]: 'http://127.0.0.1:4567/openai',
      [openAiApiKeyKey()]: 'gtw_test',
    });
    expect(prepared.env.GANTRY_DEEPAGENTS_MODEL_ID).toBe('gpt-5.5');
    // The runner builds the LangChain model from the projected provider string.
    expect(prepared.env.GANTRY_DEEPAGENTS_MODEL_PROVIDER).toBe('openai');
    // OpenAI caches the prompt prefix automatically -> 'automatic' (the runner
    // injects no cache_control breakpoints).
    expect(prepared.env.GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL).toBe(
      'automatic',
    );
    expect(prepared.env.GANTRY_DEEPAGENTS_SESSIONS_DIR).toBe(
      '/tmp/gantry/agents/test-agent/.llm-runtime/deepagents/sessions',
    );
    // gpt-5.5 has a real library profile, so the catalog declares no curated
    // window and the host must NOT project the max-input-tokens env.
    expect(prepared.env.GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS).toBeUndefined();
  });

  it('projects the curated context window for an empty-profile openai-lane model', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    const prepared = await adapter.prepare(
      prepareInput({
        effectiveModel: 'gpt-5.4-mini',
        effectiveModelEntry: catalogEntry('gpt-mini'),
      }),
    );
    // gpt-5.4-mini has no library profile -> curated 400_000 window projected.
    expect(prepared.env.GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS).toBe('400000');
  });

  it('projects the automatic cache-control mode for the OpenRouter (Kimi) lane', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    const prepared = await adapter.prepare(
      prepareInput({
        effectiveModel: 'moonshotai/kimi-k2.6',
        effectiveModelEntry: catalogEntry('kimi'),
        modelCredentialProjection: {
          env: Object.fromEntries([
            [openAiBaseUrlKey(), 'http://127.0.0.1:4567/openrouter'],
            [openAiApiKeyKey(), 'gtw_test'],
          ]),
          credentialProviders: {},
          brokerProfile: 'gantry',
          brokerApplied: true,
          brokerAuthMode: 'api_key',
        },
      }),
    );
    expect(prepared.env.GANTRY_DEEPAGENTS_MODEL_PROVIDER).toBe('openrouter');
    // Kimi/Moonshot caches automatically via OpenRouter -> 'automatic'.
    expect(prepared.env.GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL).toBe(
      'automatic',
    );
    // Kimi declares a curated 262_142 window (no library profile on this lane).
    expect(prepared.env.GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS).toBe('262142');
  });

  it('allows Gantry gateway projections for DeepAgents-routed API-key models', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModel: 'gpt-5.5',
          effectiveModelEntry: catalogEntry('gpt'),
          modelCredentialProjection: {
            env: Object.fromEntries([
              [openAiBaseUrlKey(), 'http://127.0.0.1:4567/openai'],
              [openAiApiKeyKey(), 'gtw_test'],
            ]),
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
            brokerAuthMode: 'api_key',
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects Claude OAuth credentials for the DeepAgents engine (defense in depth)', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModel: 'gpt-5.5',
          effectiveModelEntry: catalogEntry('gpt'),
          modelCredentialProjection: {
            env: Object.fromEntries([
              [openAiBaseUrlKey(), 'http://127.0.0.1:4567/openai'],
              [openAiApiKeyKey(), 'gtw_test'],
            ]),
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
            brokerAuthMode: 'claude_code_oauth',
          },
        }),
      ),
    ).rejects.toThrow(
      'DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.',
    );
  });

  it('rejects raw provider OAuth token leakage in the projection env', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    await expect(
      adapter.prepare(
        prepareInput({
          modelCredentialProjection: {
            env: { [claudeCodeOAuthTokenKey()]: 'sk-ant-oat-test' },
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
            brokerAuthMode: 'api_key',
          },
        }),
      ),
    ).rejects.toThrow(
      'DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.',
    );
  });

  it('emits the missing-Model-Access copy when no gateway projection is present', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    await expect(
      adapter.prepare(
        prepareInput({
          modelCredentialProjection: {
            env: {},
            credentialProviders: {},
            brokerProfile: 'none',
            brokerApplied: false,
          },
        }),
      ),
    ).rejects.toThrow(
      'Setup required: configure OpenAI Model Access before using gpt with DeepAgents.',
    );
  });

  it('classifies stale adapter-private session errors for host retry', () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    expect(
      adapter.isMissingProviderSessionError(
        'No DeepAgents session found with session ID: stale',
      ),
    ).toBe(true);
    expect(adapter.isMissingProviderSessionError('upstream auth failed')).toBe(
      false,
    );
  });

  it('fails when runner files are missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    await expect(adapter.prepare(prepareInput())).rejects.toThrow(
      'missing required DeepAgents execution adapter runner files',
    );
  });

  it('rejects runner paths outside the package root', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    await expect(
      adapter.prepare(
        prepareInput({ packageRootFromRunner: () => '/opt/other-package' }),
      ),
    ).rejects.toThrow('runner path escaped the Gantry package root');
  });
});

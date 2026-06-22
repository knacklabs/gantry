import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

const checkpointSetupMock = vi.hoisted(() => ({
  ensureDeepAgentsCheckpointSchema: vi.fn(async () => undefined),
}));

vi.mock(
  '@core/adapters/llm/deepagents-langchain/checkpoint-setup.js',
  () => checkpointSetupMock,
);

import {
  deepAgentsCheckpointSchema,
  DeepAgentsLangChainExecutionAdapter,
} from '@core/adapters/llm/deepagents-langchain/execution-adapter.js';
import type { AgentExecutionAdapterPrepareInput } from '@core/application/agent-execution/agent-execution-adapter.js';
import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { SkillCatalogItem } from '@core/domain/skills/skills.js';
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
const runtimePostgresUrl = 'postgres://gantry_app:secret@localhost:5432/gantry';

beforeEach(() => {
  checkpointSetupMock.ensureDeepAgentsCheckpointSchema.mockClear();
  vi.mocked(fs.existsSync).mockReset();
  vi.mocked(fs.existsSync).mockReturnValue(true);
});

function catalogEntry(alias: string): ModelCatalogEntry {
  const resolved = resolveModelSelection(alias);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.entry;
}

function installedSkill(): SkillCatalogItem {
  return {
    id: 'skill:release' as never,
    appId: 'app:test' as never,
    agentId: 'agent:test' as never,
    name: 'release-writer',
    source: 'admin_uploaded',
    status: 'installed',
    promptRefs: [],
    toolIds: [],
    workflowRefs: [],
    storage: {
      storageType: 'local-filesystem',
      storageRef: 'skill-release',
      contentHash: 'sha256:release',
      sizeBytes: 1,
    },
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
  };
}

function skillRepository(): SkillCatalogRepository {
  return {
    listEnabledSkillsForAgent: vi.fn(async () => [installedSkill()]),
  } as Partial<SkillCatalogRepository> as SkillCatalogRepository;
}

function skillArtifactStore(): SkillArtifactStore {
  return {
    getSkillArtifact: vi.fn(async () => ({
      assets: [
        {
          path: 'SKILL.md',
          content: Buffer.from(`---
name: release-writer
description: Use this skill for release notes.
---

# Release Writer
`),
          contentType: 'text/markdown',
        },
      ],
    })),
  } as Partial<SkillArtifactStore> as SkillArtifactStore;
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
    runtimeStorage: {
      postgresUrl: runtimePostgresUrl,
      postgresUrlEnv: 'GANTRY_DATABASE_URL',
      postgresSchema: 'gantry',
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
    expect(prepared.env.GANTRY_DEEPAGENTS_SESSIONS_DIR).toBeUndefined();
    expect(prepared.runnerInputPatch?.deepAgentCheckpointer).toEqual({
      databaseUrl: runtimePostgresUrl,
      schema: 'gantry_deepagents',
    });
    expect(
      checkpointSetupMock.ensureDeepAgentsCheckpointSchema,
    ).toHaveBeenCalledOnce();
    expect(
      checkpointSetupMock.ensureDeepAgentsCheckpointSchema,
    ).toHaveBeenCalledWith({
      databaseUrl: runtimePostgresUrl,
      schema: 'gantry_deepagents',
    });
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

  it('omits the Postgres checkpointer for scheduled jobs', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    const prepared = await adapter.prepare(
      prepareInput({
        input: {
          prompt: 'run job',
          chatJid: 'job:1',
          isScheduledJob: true,
        },
      }),
    );

    expect(prepared.runnerInputPatch?.deepAgentCheckpointer).toBeUndefined();
    expect(
      checkpointSetupMock.ensureDeepAgentsCheckpointSchema,
    ).not.toHaveBeenCalled();
  });

  it('projects selected DeepAgents skills from reviewed Gantry artifacts', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    const prepared = await adapter.prepare(
      prepareInput({
        input: {
          prompt: 'write release notes',
          chatJid: 'tg:test',
          attachedSkillSourceIds: ['skill:release'],
        },
        options: {
          skillRepository: skillRepository(),
          skillArtifactStore: skillArtifactStore(),
          skillContext: {
            appId: 'app:test' as never,
            agentId: 'agent:test' as never,
          },
        },
      }),
    );

    expect(prepared.runnerInputPatch?.deepAgentSkills).toMatchObject({
      sources: ['/skills/'],
      selectedSkillIds: ['skill:release'],
      skillCount: 1,
      fileCount: 1,
      contentBytes: expect.any(Number),
    });
    expect(prepared.runnerInputPatch?.deepAgentSkills?.files).toEqual({
      '/skills/release-writer/SKILL.md': expect.objectContaining({
        content: expect.stringContaining('name: release-writer'),
        mimeType: 'text/markdown',
      }),
    });
  });

  it('fails selected DeepAgents skills closed when skill storage is unavailable', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    await expect(
      adapter.prepare(
        prepareInput({
          input: {
            prompt: 'write release notes',
            chatJid: 'tg:test',
            attachedSkillSourceIds: ['skill:release'],
          },
        }),
      ),
    ).rejects.toThrow('require configured Gantry skill storage');
  });

  it('fails live DeepAgents preparation when runtime Postgres is not configured', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          runtimeStorage: {
            postgresUrl: null,
            postgresUrlEnv: 'GANTRY_DATABASE_URL',
            postgresSchema: 'gantry',
          },
        }),
      ),
    ).rejects.toThrow(
      'DeepAgents live sessions require runtime Postgres storage',
    );
    expect(
      checkpointSetupMock.ensureDeepAgentsCheckpointSchema,
    ).not.toHaveBeenCalled();
  });

  it('derives an isolated checkpoint schema from the configured storage schema', () => {
    expect(deepAgentsCheckpointSchema('gantry')).toBe('gantry_deepagents');
    expect(deepAgentsCheckpointSchema('a'.repeat(63))).toMatch(
      /^a+_deepagents$/,
    );
    expect(deepAgentsCheckpointSchema('a'.repeat(63))).toHaveLength(63);
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

  it('projects optional OpenRouter provider routing as snake_case runner env', async () => {
    const adapter = new DeepAgentsLangChainExecutionAdapter();
    const prepared = await adapter.prepare(
      prepareInput({
        effectiveModel: 'moonshotai/kimi-k2.6',
        effectiveModelEntry: {
          ...catalogEntry('kimi'),
          providerRouting: {
            openrouter: {
              only: ['moonshotai'],
              allowFallbacks: false,
              requireParameters: true,
              dataCollection: 'deny',
              sort: 'latency',
            },
          },
        },
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

    expect(
      JSON.parse(prepared.env.GANTRY_DEEPAGENTS_OPENROUTER_PROVIDER_ROUTING!),
    ).toEqual({
      only: ['moonshotai'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      sort: 'latency',
    });
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

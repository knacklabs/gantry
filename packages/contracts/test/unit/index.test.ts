import { describe, expect, it } from 'vitest';
import type {
  CreateJobInput,
  UpdateJobInput,
} from '../../../sdk/src/job-model-types.js';

import {
  AgentCapabilitiesResponseSchema,
  AgentDelegatesResponseSchema,
  AgentHarnessSchema,
  AgentResponseSchema,
  ReplaceAgentDelegatesRequestSchema,
  UpdateAgentRequestSchema,
  ConversationInstallRequestSchema,
  ConversationInstallListResponseSchema,
  ConversationInstallResponseSchema,
  BrowserProfileResponseSchema,
  ProviderAccountListResponseSchema,
  ProviderAccountResponseSchema,
  ProviderListResponseSchema,
  ProviderResponseSchema,
  ContractMetadataSchema,
  ConversationListResponseSchema,
  ConversationResponseSchema,
  ConversationThreadListResponseSchema,
  ConversationThreadResponseSchema,
  CreateAgentRequestSchema,
  CreateJobResponseSchema,
  CreateJobRequestSchema,
  CreateSessionRequestSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
  JobResponseSchema,
  JobModelPreviewSchema,
  JobScheduleSchema,
  LlmProfileRefSchema,
  MEMORY_IPC_ACTIONS,
  MemoryKindSchema,
  MemoryItemResponseSchema,
  MemorySearchRequestSchema,
  MessageListResponseSchema,
  MessageResponseSchema,
  ModelDefaultsPatchRequestSchema,
  ModelDefaultsResponseSchema,
  ModelPreviewRequestSchema,
  ModelPreviewResponseSchema,
  PageRequestSchema,
  ProviderSessionResponseSchema,
  RuntimeLimitSchema,
  RuntimeSettingsConfiguredAgentSchema,
  RuntimeSettingsResponseSchema,
  SchemaDescriptorSchema,
  StreamEventSchema,
  ToolCatalogItemResponseSchema,
  ToolCatalogKindSchema,
  ToolCatalogProviderToolNameSchema,
  UpdateJobRequestSchema,
  PersonAliasResponseSchema,
  createCursorPageResponseSchema,
  createPageResponseSchema,
} from '@contracts-src/index.js';

function expectInvalid(
  schema: { safeParse: (input: unknown) => { success: boolean } },
  input: unknown,
) {
  expect(schema.safeParse(input).success).toBe(false);
}

const iso = '2026-04-27T00:00:00.000Z';

const message = {
  id: 'message-1',
  appId: 'app-1',
  providerAccountId: 'provider-account-1',
  conversationId: 'conversation-1',
  direction: 'outbound',
  trust: 'trusted',
  parts: [{ ordinal: 0, kind: 'text', payload: { text: 'hello' } }],
  createdAt: iso,
};

const runEvent = {
  id: 'run-event-1',
  appId: 'app-1',
  runId: 'run-1',
  type: 'model.output',
  payload: { text: 'hello' },
  createdAt: iso,
};

const permissionDecision = {
  id: 'decision-1',
  appId: 'app-1',
  ruleIds: ['rule-1'],
  effect: 'allow',
  reason: 'Matched allow rule',
  createdAt: iso,
};

describe('contracts package', () => {
  it('exports memory IPC actions from the canonical memory module', () => {
    expect(MEMORY_IPC_ACTIONS).toEqual([
      'memory_search',
      'memory_save',
      'brain_search',
      'brain_query',
      'brain_write',
      'memory_patch',
      'memory_demote',
      'continuity_summary',
      'memory_consolidate',
      'memory_dream',
      'memory_review_pending',
      'memory_review_decision',
      'procedure_save',
      'procedure_patch',
    ]);
  });

  it('rejects retired project_fact as a public memory kind', () => {
    expect(MemoryKindSchema.safeParse('project_fact').success).toBe(false);
    expect(MemoryKindSchema.parse('fact')).toBe('fact');
  });

  it('exports and validates contract primitives', () => {
    expect(IsoDateTimeSchema.parse(iso)).toBe(iso);
    expectInvalid(IsoDateTimeSchema, '2026-04-27T00:00:00');

    expect(ContractMetadataSchema.parse({ provider: 'sdk' })).toEqual({
      provider: 'sdk',
    });
    expect(ExternalReferenceSchema.parse({ id: 'external-1' })).toMatchObject({
      id: 'external-1',
    });

    expect(RuntimeLimitSchema.parse({ timeoutMs: 1000 })).toEqual({
      timeoutMs: 1000,
    });
    expectInvalid(RuntimeLimitSchema, { timeoutMs: 0 });
    expectInvalid(RuntimeLimitSchema, { maxTurns: 1.5 });

    expect(SchemaDescriptorSchema.parse({ schema: {} })).toEqual({
      format: 'unknown',
      schema: {},
    });
    expectInvalid(SchemaDescriptorSchema, { format: 'protobuf', schema: {} });

    expect(LlmProfileRefSchema.parse({ modelAlias: 'opus' })).toEqual({
      modelAlias: 'opus',
    });
  });

  it('validates configured agent control settings', () => {
    const agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: ['researcher', 'future_agent'],
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
    };
    expect(
      RuntimeSettingsConfiguredAgentSchema.parse({
        ...agent,
        maxTurns: 12,
        maxRunTokens: 8192,
        effort: 'xhigh',
        permissionMode: 'auto_strict',
        thinking: { mode: 'on', budgetTokens: 4096 },
        maxOutputTokens: 2048,
        toolRules: [
          {
            tool: 'Bash',
            action: 'block',
            when: { arg: 'command', matches: '^rm\\s' },
            reason: 'destructive command',
          },
          {
            tool: 'Deploy',
            action: 'require_prior',
            prior: 'Test',
            reason: 'tests must pass first',
          },
        ],
      }),
    ).toMatchObject({
      maxTurns: 12,
      maxRunTokens: 8192,
      effort: 'xhigh',
      permissionMode: 'auto_strict',
      thinking: { mode: 'on', budgetTokens: 4096 },
      maxOutputTokens: 2048,
      delegates: ['researcher', 'future_agent'],
      toolRules: expect.arrayContaining([
        expect.objectContaining({ action: 'block' }),
        expect.objectContaining({ action: 'require_prior' }),
      ]),
    });
    expectInvalid(RuntimeSettingsConfiguredAgentSchema, {
      ...agent,
      permissionMode: 'always',
    });
    expectInvalid(RuntimeSettingsConfiguredAgentSchema, {
      ...agent,
      thinking: { mode: 'off', budgetTokens: 1 },
    });
    expectInvalid(RuntimeSettingsConfiguredAgentSchema, {
      ...agent,
      maxRunTokens: 0,
    });
    expectInvalid(RuntimeSettingsConfiguredAgentSchema, {
      ...agent,
      maxOutputTokens: 0,
    });
    expectInvalid(RuntimeSettingsConfiguredAgentSchema, {
      ...agent,
      delegates: ['researcher', 42],
    });
    expectInvalid(RuntimeSettingsConfiguredAgentSchema, {
      ...agent,
      toolRules: [
        {
          tool: 'Bash',
          action: 'block',
          when: { arg: 'command', matches: '[' },
          reason: 'bad regex',
        },
      ],
    });
  });

  it('validates provider-neutral model default contracts', () => {
    expect(
      ModelDefaultsPatchRequestSchema.parse({
        chat: 'kimi',
        jobs: 'inherit',
        memory: null,
      }),
    ).toMatchObject({ chat: 'kimi' });
    expectInvalid(ModelDefaultsPatchRequestSchema, {
      providerPreset: 'custom-provider',
    });
    expectInvalid(ModelDefaultsPatchRequestSchema, {
      providerPreset: 'anthropic',
      providerModelId: 'claude-sonnet-4-6',
    });
    expect(
      ModelDefaultsResponseSchema.safeParse({
        provider: {
          id: 'openrouter',
          label: 'OpenRouter',
        },
        chat: {
          configuredAlias: 'kimi',
          effectiveAlias: 'kimi',
          source: 'settings.yaml agent.default_model',
          inherited: false,
          workload: 'chat',
          model: null,
        },
        jobs: {
          oneTime: {
            configuredAlias: null,
            effectiveAlias: 'kimi',
            source: 'settings.yaml agent.default_model',
            inherited: true,
            workload: 'one_time_job',
            model: null,
          },
          recurring: {
            configuredAlias: null,
            effectiveAlias: 'kimi',
            source: 'settings.yaml agent.default_model',
            inherited: true,
            workload: 'recurring_job',
            model: null,
          },
        },
        memory: {
          mode: 'provider-managed',
          extractor: {
            configuredAlias: 'kimi',
            effectiveAlias: 'kimi',
            source: 'settings.yaml memory.llm.models.extractor',
            inherited: false,
            workload: 'memory_extractor',
            model: null,
          },
          dreaming: {
            configuredAlias: 'kimi',
            effectiveAlias: 'kimi',
            source: 'settings.yaml memory.llm.models.dreaming',
            inherited: false,
            workload: 'memory_dreaming',
            model: null,
          },
          consolidation: {
            configuredAlias: 'kimi',
            effectiveAlias: 'kimi',
            source: 'settings.yaml memory.llm.models.consolidation',
            inherited: false,
            workload: 'memory_consolidation',
            model: null,
          },
        },
        defaults: {
          chat: {
            configuredAlias: 'kimi',
            effectiveAlias: 'kimi',
            source: 'settings.yaml agent.default_model',
            inherited: false,
            workload: 'chat',
            model: {
              id: 'openrouter:kimi-k2.6',
              displayName: 'Kimi K2.6',
              aliases: ['kimi'],
              recommendedAlias: 'kimi',
              responseFamily: 'anthropic',
              executionRoutes: [
                {
                  harness: 'deepagents',
                  executionProviderId: 'deepagents:langchain',
                },
              ],
              credentialProfileRef: 'gantry-model-access',
              modelRoute: {
                id: 'openrouter',
                label: 'OpenRouter',
                metadata: {
                  providerModelId: 'moonshotai/kimi-k2.6',
                },
              },
              capabilities: {
                streaming: true,
                toolUse: true,
                mcpProjection: true,
                browserProjection: true,
                sandboxProjection: true,
                providerSessionResume: true,
                thinking: true,
                tokenAccounting: true,
                cacheAccounting: true,
                structuredOutput: false,
              },
              supportedWorkloads: ['chat', 'memory_extractor'],
              contextWindowTokens: 262142,
              maxOutputTokens: 64000,
              cacheMode: 'openrouter-provider-prompt',
              cacheTokenFields: [],
              cacheSupport: {
                providerId: 'openrouter',
                providerLabel: 'OpenRouter',
                cacheProvider: 'openrouter-provider',
                statusLabel:
                  'automatic provider cache; response cache available but disabled',
                prompt: {
                  mode: 'openrouter_automatic_prefix',
                  automatic: true,
                  requestControl: 'provider_automatic_prefix',
                  ttlOptions: ['5m', '1h'],
                  minimumTokenThresholds: [
                    {
                      modelFamily: 'anthropic-compatible',
                      tokens: 2048,
                    },
                  ],
                  usageFields: {
                    readTokens: 'prompt_tokens_details.cached_tokens',
                    writeTokens: 'prompt_tokens_details.cache_write_tokens',
                  },
                  supported: true,
                  accounted: true,
                },
                response: {
                  mode: 'openrouter_response_cache',
                  enabledByDefault: false,
                  requestControl: 'request_header',
                  requestHeaders: [
                    'X-OpenRouter-Cache',
                    'X-OpenRouter-Cache-TTL',
                    'X-OpenRouter-Cache-Clear',
                  ],
                  responseHeaders: [
                    'X-OpenRouter-Cache-Status',
                    'X-OpenRouter-Cache-Age',
                    'X-OpenRouter-Cache-TTL',
                  ],
                  usageBehavior: 'zero_usage_on_hit',
                  available: true,
                },
                tokenFields: [],
              },
              supportsThinking: true,
              supportsTools: true,
              source: {
                label: 'OpenRouter Kimi K2.6 API',
                url: 'https://openrouter.ai/moonshotai/kimi-k2.6/api',
                verifiedAt: '2026-05-21',
              },
              experimental: true,
            },
          },
          oneTime: {
            configuredAlias: null,
            effectiveAlias: 'kimi',
            source: 'settings.yaml agent.default_model',
            inherited: true,
            workload: 'one_time_job',
            model: null,
          },
          recurring: {
            configuredAlias: null,
            effectiveAlias: 'kimi',
            source: 'settings.yaml agent.default_model',
            inherited: true,
            workload: 'recurring_job',
            model: null,
          },
          memoryExtractor: {
            configuredAlias: 'kimi',
            effectiveAlias: 'kimi',
            source: 'settings.yaml memory.llm.models.extractor',
            inherited: false,
            workload: 'memory_extractor',
            model: null,
          },
          memoryDreaming: {
            configuredAlias: 'kimi',
            effectiveAlias: 'kimi',
            source: 'settings.yaml memory.llm.models.dreaming',
            inherited: false,
            workload: 'memory_dreaming',
            model: null,
          },
          memoryConsolidation: {
            configuredAlias: 'kimi',
            effectiveAlias: 'kimi',
            source: 'settings.yaml memory.llm.models.consolidation',
            inherited: false,
            workload: 'memory_consolidation',
            model: null,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      ModelPreviewRequestSchema.parse({
        target: 'job',
        jobId: 'job-1',
      }),
    ).toEqual({ target: 'job', jobId: 'job-1' });
    expectInvalid(ModelPreviewRequestSchema, {
      target: 'job',
      providerModelId: 'moonshotai/kimi-k2.6',
    });
    expect(
      ModelPreviewResponseSchema.parse({
        target: 'job',
        jobId: 'job-1',
        kind: 'recurring',
        selection: {
          configuredAlias: null,
          effectiveAlias: 'sonnet',
          source: 'settings.yaml agents.<agent>.model',
          inherited: true,
          workload: 'recurring_job',
          model: null,
        },
        why: ['job job-1 inherits settings.yaml agents.<agent>.model'],
      }),
    ).toMatchObject({
      target: 'job',
      selection: {
        effectiveAlias: 'sonnet',
        source: 'settings.yaml agents.<agent>.model',
      },
    });
    // target 'agent' request round-trips agentId + modelAlias.
    expect(
      ModelPreviewRequestSchema.parse({
        target: 'agent',
        agentId: 'main_agent',
        modelAlias: 'gpt',
      }),
    ).toEqual({
      target: 'agent',
      agentId: 'main_agent',
      modelAlias: 'gpt',
    });
    // target 'agent' response carries the selected public harness diagnostics.
    expect(
      ModelPreviewResponseSchema.parse({
        target: 'agent',
        agentId: 'main_agent',
        agentHarness: 'deepagents',
        credentialProfile: 'openai',
        executionProviderId: 'deepagents:langchain',
        selection: {
          configuredAlias: null,
          effectiveAlias: 'gpt',
          source: 'agent main_agent harness deepagents',
          inherited: false,
          workload: 'chat',
          model: null,
        },
        why: [
          'agent main_agent uses deepagents harness on the openai endpoint',
        ],
      }),
    ).toMatchObject({
      target: 'agent',
      agentId: 'main_agent',
      agentHarness: 'deepagents',
      executionProviderId: 'deepagents:langchain',
    });
    expect(
      CreateJobResponseSchema.parse({
        jobId: 'job-1',
        modelAlias: 'sonnet',
        modelSource: 'settings.yaml agents.<agent>.model',
        modelSelection: {
          alias: 'sonnet',
          source: 'settings.yaml agents.<agent>.model',
          explicit: false,
        },
        model: null,
      }),
    ).toMatchObject({
      modelAlias: 'sonnet',
      modelSource: 'settings.yaml agents.<agent>.model',
    });
    const jobModelPreview = {
      displayName: 'Claude Sonnet 4.6',
      responseFamily: 'anthropic',
      modelRoute: {
        id: 'anthropic',
        label: 'Anthropic',
      },
      contextWindowTokens: 200000,
      maxOutputTokens: 64000,
      cachePolicy: 'anthropic-prompt-cache',
    };
    expect(JobModelPreviewSchema.parse(jobModelPreview)).toEqual(
      jobModelPreview,
    );
    // DeepAgents job-eligible models omit maxOutputTokens (and some omit
    // contextWindowTokens); JSON.stringify drops the undefined fields, so a
    // preview without them must still parse.
    const deepAgentsJobPreview = {
      displayName: 'Groq Llama 3.3 70B Versatile',
      responseFamily: 'openai',
      modelRoute: {
        id: 'groq',
        label: 'Groq',
      },
      cachePolicy: 'openai-automatic-prompt',
    };
    expect(JobModelPreviewSchema.parse(deepAgentsJobPreview)).toEqual(
      deepAgentsJobPreview,
    );
    expect(
      JobModelPreviewSchema.parse({
        ...jobModelPreview,
        responseFamily: 'gemini',
        modelRoute: {
          id: 'gemini',
          label: 'Gemini',
        },
      }),
    ).toMatchObject({
      responseFamily: 'gemini',
      modelRoute: { id: 'gemini' },
    });
    expectInvalid(JobModelPreviewSchema, {
      ...jobModelPreview,
      providerSlug: 'anthropic',
    });
    expectInvalid(JobModelPreviewSchema, {
      ...jobModelPreview,
      modelRoute: {
        ...jobModelPreview.modelRoute,
        providerModelId: 'claude-sonnet-4-6',
      },
    });
  });

  it('accepts relationship mode in public runtime settings agents', () => {
    const parsed = RuntimeSettingsResponseSchema.parse({
      settings: {
        desiredState: { authoritative: true },
        agent: {
          name: 'Gantry',
          defaultModel: 'opus',
          agentHarness: 'auto',
          oneTimeJobDefaultModel: 'inherit',
          recurringJobDefaultModel: 'inherit',
        },
        agents: {
          main_agent: {
            name: 'Main Agent',
            folder: 'main_agent',
            persona: 'generalist',
            relationshipMode: 'organization',
            model: 'sonnet',
            agentHarness: 'deepagents',
            permissionMode: 'auto_strict',
            oneTimeJobDefaultModel: 'inherit',
            recurringJobDefaultModel: 'inherit',
            delegates: ['researcher', 'future_agent'],
            bindings: {
              main_agent_shared_channel: {
                jid: 'slack:C123',
                provider: 'slack',
                providerAccountId: 'slack_one',
                name: 'shared',
                threadId: '171.222',
                trigger: '@main',
                addedAt: iso,
                requiresTrigger: true,
                permissionMode: 'auto_strict',
              },
            },
            sources: { skills: [], mcpServers: [], tools: [] },
            capabilities: [],
          },
        },
        providers: {},
        providerAccounts: {
          slack_one: {
            agentId: 'main_agent',
            provider: 'slack',
            label: 'Main Slack',
            status: 'active',
            runtimeSecretRefs: { bot_token: 'gantry-secret:slack' },
          },
        },
        conversations: {
          shared_channel: {
            providerAccount: 'slack_one',
            externalId: 'slack:C123',
            kind: 'channel',
            displayName: 'shared',
            brainHarvest: false,
            senderPolicy: { allow: '*', mode: 'trigger' },
            controlApprovers: ['slack:UADMIN'],
            installedAgents: {
              main_agent: {
                agentId: 'main_agent',
                providerAccountId: 'slack_one',
                threadId: '171.222',
                status: 'active',
                addedAt: iso,
                memoryScope: 'conversation',
                trigger: '@main',
                requiresTrigger: true,
                permissionMode: 'auto_strict',
              },
            },
          },
        },
        bindings: {
          main_agent_shared_channel: {
            agent: 'main_agent',
            providerAccountId: 'slack_one',
            installKey: 'main_agent',
            conversation: 'shared_channel',
            threadId: '171.222',
            trigger: '@main',
            addedAt: iso,
            requiresTrigger: true,
            memoryScope: 'conversation',
            permissionMode: 'auto_strict',
          },
        },
        conversationInstalls: {
          main_agent_shared_channel: {
            agentId: 'main_agent',
            providerAccountId: 'slack_one',
            conversationId: 'shared_channel',
            threadId: '171.222',
            status: 'active',
            addedAt: iso,
            memoryScope: 'conversation',
            trigger: '@main',
            requiresTrigger: true,
            permissionMode: 'auto_strict',
          },
        },
        memory: { enabled: true, dreaming: { enabled: false } },
        runtime: {
          queue: {
            maxMessageRuns: 1,
            maxJobRuns: 1,
            maxMessageBacklog: 0,
            maxTaskBacklog: 0,
            maxRetries: 0,
            baseRetryMs: 0,
            drainDeadlineMs: 120000,
          },
          sandbox: {
            provider: 'sandbox_runtime',
            resourceLimits: {
              cpuSeconds: 30,
              memoryMb: 1024,
              maxProcesses: 24,
            },
          },
          artifactStore: {
            driver: 'local',
          },
          deploymentMode: 'workstation',
        },
        browser: {
          usage: {
            enabled: true,
            mode: 'audit',
            windowMs: 60000,
            maxActionsPerWindow: 20,
            maxConcurrentPerSite: 2,
          },
        },
        permissions: {
          yoloMode: { enabled: false, denylist: [], denylistPaths: [] },
          egress: { denylist: [] },
          autoMode: { model: 'sonnet' },
        },
      },
    });

    expect(parsed.settings.agents.main_agent?.relationshipMode).toBe(
      'organization',
    );
    expect(parsed.settings.agent.agentHarness).toBe('auto');
    expect(parsed.settings.agents.main_agent?.agentHarness).toBe('deepagents');
    expect(parsed.settings.agents.main_agent?.permissionMode).toBe(
      'auto_strict',
    );
    expect(parsed.settings.agents.main_agent?.delegates).toEqual([
      'researcher',
      'future_agent',
    ]);
    expect(
      parsed.settings.agents.main_agent?.bindings.main_agent_shared_channel
        ?.permissionMode,
    ).toBe('auto_strict');
    expect(
      parsed.settings.conversations.shared_channel?.installedAgents.main_agent
        ?.permissionMode,
    ).toBe('auto_strict');
    expect(
      parsed.settings.bindings.main_agent_shared_channel?.permissionMode,
    ).toBe('auto_strict');
    expect(
      parsed.settings.conversationInstalls.main_agent_shared_channel
        ?.permissionMode,
    ).toBe('auto_strict');
    expect(parsed.settings.permissions.autoMode).toEqual({ model: 'sonnet' });
    expectInvalid(RuntimeSettingsResponseSchema, {
      settings: {
        ...parsed.settings,
        permissions: {
          ...parsed.settings.permissions,
          autoMode: { model: 'sonnet', timeoutMs: 3000 },
        },
      },
    });
    expect(
      parsed.settings.conversationInstalls.main_agent_shared_channel?.threadId,
    ).toBe('171.222');
    expect(parsed.settings.bindings.main_agent_shared_channel).toMatchObject({
      providerAccountId: 'slack_one',
      installKey: 'main_agent',
    });
    expect(
      parsed.settings.agents.main_agent?.bindings.main_agent_shared_channel,
    ).toMatchObject({
      providerAccountId: 'slack_one',
      threadId: '171.222',
    });
  });

  it('keeps public tool catalog contracts provider-neutral', () => {
    expect(
      ToolCatalogKindSchema.safeParse(['anthropic', 'sdk'].join('_')).success,
    ).toBe(false);
    expect(ToolCatalogKindSchema.parse('browser')).toBe('browser');
    expect(
      ToolCatalogProviderToolNameSchema.parse('adapter-private-tool'),
    ).toBe('adapter-private-tool');
    expectInvalid(ToolCatalogProviderToolNameSchema, '');

    expect(
      ToolCatalogItemResponseSchema.parse({
        id: 'tool:Browser',
        appId: 'app-1',
        name: 'Browser',
        kind: 'browser',
        provider: 'gantry',
        displayName: 'Browser',
        category: 'web',
        inputSchema: { schema: {} },
        risk: 'medium',
        selectable: true,
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ id: 'tool:Browser', kind: 'browser' });
  });

  it('validates representative canonical DTOs and rejects constrained invalid input', () => {
    expect(
      CreateSessionRequestSchema.parse({
        conversationId: 'conversation-1',
      }),
    ).toMatchObject({ conversationId: 'conversation-1' });
    expectInvalid(CreateSessionRequestSchema, {
      conversationId: 'conversation-1',
      unexpectedField: 'sonnet',
    });

    expect(
      AgentResponseSchema.parse({
        id: 'agent-1',
        appId: 'app-1',
        name: 'Operator',
        status: 'active',
        agentHarness: 'deepagents',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({
      id: 'agent-1',
      appId: 'app-1',
      agentHarness: 'deepagents',
    });
    // agentHarness is a required public field on the response and is enum-bound.
    expectInvalid(AgentResponseSchema, {
      id: 'agent-1',
      appId: 'app-1',
      name: 'Operator',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    });
    expectInvalid(AgentResponseSchema, {
      id: 'agent-1',
      appId: 'app-1',
      name: 'Operator',
      status: 'active',
      agentHarness: 'langchain',
      createdAt: iso,
      updatedAt: iso,
    });
    expectInvalid(AgentResponseSchema, {
      id: 'agent-1',
      appId: 'app-1',
      name: 'Operator',
      status: 'bad',
      agentHarness: 'deepagents',
      createdAt: iso,
      updatedAt: iso,
    });
    expect(AgentHarnessSchema.options).toEqual([
      'auto',
      'anthropic_sdk',
      'deepagents',
    ]);
    expect(
      CreateAgentRequestSchema.parse({
        appId: 'app-1',
        name: 'Operator',
        agentHarness: 'auto',
      }),
    ).toEqual({ appId: 'app-1', name: 'Operator', agentHarness: 'auto' });
    expect(UpdateAgentRequestSchema.parse({ name: 'Operator' })).toEqual({
      name: 'Operator',
    });
    expect(
      UpdateAgentRequestSchema.parse({ agentHarness: 'anthropic_sdk' }),
    ).toEqual({ agentHarness: 'anthropic_sdk' });
    expect(UpdateAgentRequestSchema.parse({ status: 'active' })).toEqual({
      status: 'active',
    });
    expect(
      ReplaceAgentDelegatesRequestSchema.parse({
        delegates: [' researcher '],
        expectedRevision: 4,
      }),
    ).toEqual({ delegates: ['researcher'], expectedRevision: 4 });
    expect(
      AgentDelegatesResponseSchema.parse({
        agentId: 'agent:orchestrator',
        revision: 4,
        delegates: ['researcher'],
        resolved: [
          {
            ref: 'researcher',
            agentId: 'agent:researcher',
            toolName: 'delegate_to_researcher_abcd',
            displayName: 'Researcher',
            persona: 'research',
          },
        ],
      }),
    ).toMatchObject({
      agentId: 'agent:orchestrator',
      delegates: ['researcher'],
      resolved: [{ persona: 'research' }],
    });
    expectInvalid(ReplaceAgentDelegatesRequestSchema, {
      delegates: ['researcher'],
      unexpected: true,
    });
    expectInvalid(ReplaceAgentDelegatesRequestSchema, { delegates: [''] });
    expectInvalid(ReplaceAgentDelegatesRequestSchema, {
      delegates: ['x'.repeat(161)],
    });
    expectInvalid(ReplaceAgentDelegatesRequestSchema, {
      delegates: Array.from({ length: 101 }, (_, index) => `agent-${index}`),
    });
    expectInvalid(AgentDelegatesResponseSchema, {
      agentId: 'agent:orchestrator',
      revision: 4,
      delegates: [],
      resolved: [
        {
          ref: 'researcher',
          agentId: 'agent:researcher',
          toolName: 'delegate_to_researcher_abcd',
          displayName: 'Researcher',
          persona: 'finance',
        },
      ],
    });
    expectInvalid(CreateAgentRequestSchema, { appId: 'app-1', name: '' });
    const forbiddenAgentRequestFields = [
      'description',
      'promptProfileRef',
      'llmProfileId',
      'toolIds',
      'skillIds',
      'permissionPolicyIds',
      'sandboxProfileId',
      'workspaceSnapshotId',
      'runtimeLimits',
      'metadata',
      'agentEngine',
      'executionProviderId',
      'unexpectedField',
    ];
    for (const field of forbiddenAgentRequestFields) {
      expectInvalid(CreateAgentRequestSchema, {
        appId: 'app-1',
        name: 'Operator',
        [field]: 'deepagents',
      });
      expectInvalid(UpdateAgentRequestSchema, {
        status: 'active',
        [field]: 'deepagents',
      });
    }
    expect(
      ProviderSessionResponseSchema.parse({
        provider: 'anthropic:claude-agent-sdk',
        status: 'active',
        hasProviderResume: true,
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({
      provider: 'anthropic:claude-agent-sdk',
      status: 'active',
      hasProviderResume: true,
    });
    expectInvalid(ProviderSessionResponseSchema, {
      id: 'provider-session-sdk-resume-handle',
      provider: 'anthropic:claude-agent-sdk',
      status: 'active',
      hasProviderResume: true,
      createdAt: iso,
      updatedAt: iso,
    });
    expect(
      AgentCapabilitiesResponseSchema.parse({
        agentId: 'agent-1',
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [
          { id: 'mcp__gantry__service_restart', version: 'builtin' },
        ],
        toolAccess: {
          configuredTools: ['mcp__gantry__service_restart'],
          defaultTools: [],
          availableButGatedTools: ['Bash'],
          requestableAdminTools: [],
          source: 'settings.yaml agents.agent-1.capabilities',
        },
        updatedAt: iso,
      }),
    ).toMatchObject({ agentId: 'agent-1' });
    expectInvalid(AgentCapabilitiesResponseSchema, {
      agentId: 'agent-1',
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      toolAccess: {
        configuredTools: [],
        defaultTools: [],
        availableButGatedTools: [],
        requestableAdminTools: [],
        source: 'settings.yaml agents.agent-1.capabilities',
        inheritedTools: [],
      },
      updatedAt: iso,
    });

    const sdkCreatePayload = {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
        sessionId: 'session-1',
      },
      notificationRoutes: [
        {
          conversationJid: 'app:app-one:session-1',
          threadId: null,
          providerAccountId: 'provider-account:app-one',
          label: 'primary',
        },
      ],
      accessRequirements: [
        {
          target: {
            kind: 'capability',
            capabilityId: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executablePath: '/usr/local/bin/acme',
              executableVersion: 'v0.9.0',
              executableHash: 'sha256:abc123',
              commandTemplate: '/usr/local/bin/acme records append *',
            },
          },
          reason: 'Append reviewed records after each run',
        },
        { target: { kind: 'tool_rule', rule: 'Browser' } },
      ],
      kind: 'recurring',
      schedule: { type: 'cron', value: '0 9 * * *' },
      modelAlias: 'sonnet',
    } satisfies CreateJobInput;
    expect(CreateJobRequestSchema.parse(sdkCreatePayload)).toMatchObject({
      name: 'Daily summary',
      accessRequirements: [
        expect.objectContaining({
          target: expect.objectContaining({
            kind: 'capability',
            capabilityId: 'acme.records.append',
            implementation: expect.objectContaining({ name: 'acme' }),
          }),
        }),
        expect.objectContaining({
          target: { kind: 'tool_rule', rule: 'Browser' },
        }),
      ],
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        sessionId: 'session-1',
      },
      notificationRoutes: [
        expect.objectContaining({
          providerAccountId: 'provider-account:app-one',
        }),
      ],
    });
    expectInvalid(CreateJobRequestSchema, {
      name: '',
      prompt: 'Summarize open work',
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: '',
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
      modelAlias: 'sonnet',
      modelProfileId: 'anthropic:sonnet-4.6',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
        sessionId: null,
      },
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
      model: 'claude-sonnet-4-6',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
      providerModelId: 'sonnet',
    });
    expectInvalid(CreateJobRequestSchema, {
      ...sdkCreatePayload,
      linkedSessions: ['app:app-one:session-1'],
    });
    expectInvalid(CreateJobRequestSchema, {
      ...sdkCreatePayload,
      deliverTo: ['app:app-one:session-1'],
    });
    expectInvalid(CreateJobRequestSchema, {
      ...sdkCreatePayload,
      notificationTarget: { linkedSessions: [], threadId: null, silent: false },
    });
    expectInvalid(CreateJobRequestSchema, {
      ...sdkCreatePayload,
      threadId: 'legacy-thread',
    });
    expectInvalid(CreateJobRequestSchema, {
      ...sdkCreatePayload,
      executionMode: 'serialized',
    });
    expectInvalid(CreateJobRequestSchema, {
      ...sdkCreatePayload,
      execution_mode: 'serialized',
    });
    expectInvalid(CreateJobRequestSchema, {
      ...sdkCreatePayload,
      serialize: true,
    });

    const sdkUpdatePayload = {
      modelAlias: null,
      accessRequirements: [
        {
          target: { kind: 'capability', capabilityId: 'acme.records.append' },
          reason: 'Append reviewed records after each run',
        },
        { target: { kind: 'tool_rule', rule: 'Browser' } },
      ],
      status: 'paused',
    } satisfies UpdateJobInput;
    expect(UpdateJobRequestSchema.parse(sdkUpdatePayload)).toEqual({
      modelAlias: null,
      accessRequirements: [
        {
          target: { kind: 'capability', capabilityId: 'acme.records.append' },
          reason: 'Append reviewed records after each run',
        },
        { target: { kind: 'tool_rule', rule: 'Browser' } },
      ],
      status: 'paused',
    });
    expectInvalid(UpdateJobRequestSchema, {
      modelAlias: 'sonnet',
      modelProfileId: 'anthropic:sonnet-4.6',
    });
    expectInvalid(UpdateJobRequestSchema, {
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
    });
    expectInvalid(UpdateJobRequestSchema, {
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
        sessionId: null,
      },
    });
    expectInvalid(UpdateJobRequestSchema, {
      model: 'claude-sonnet-4-6',
    });
    expectInvalid(UpdateJobRequestSchema, {
      linkedSessions: ['app:app-one:session-1'],
    });
    expectInvalid(UpdateJobRequestSchema, {
      deliverTo: ['app:app-one:session-1'],
    });
    expectInvalid(UpdateJobRequestSchema, {
      notificationTarget: { linkedSessions: [], threadId: null, silent: false },
    });
    expectInvalid(UpdateJobRequestSchema, {
      threadId: 'legacy-thread',
    });
    expectInvalid(UpdateJobRequestSchema, {
      executionMode: 'serialized',
    });
    expectInvalid(UpdateJobRequestSchema, {
      execution_mode: 'serialized',
    });
    expectInvalid(UpdateJobRequestSchema, {
      serialize: true,
    });
    expect(
      JobResponseSchema.parse({
        jobId: 'job-1',
        name: 'Daily summary',
        kind: 'once',
        status: 'active',
        schedule: { type: 'once', runAt: iso },
        executionContext: {
          conversationJid: 'app:app-one:session-1',
          threadId: null,
          workspaceKey: 'app:app-one:session-1',
          sessionId: null,
        },
        notificationRoutes: [
          {
            conversationJid: 'app:app-one:session-1',
            threadId: null,
            label: 'primary',
          },
        ],
        accessRequirements: [
          {
            target: { kind: 'capability', capabilityId: 'acme.records.append' },
            reason: 'Append reviewed records after each run',
          },
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
        nextRun: iso,
        lastRun: null,
        staleness: 'missed_window',
        health: {
          state: 'needs_permission',
          latestRunId: 'run-1',
          latestRunStatus: 'failed',
          latestSummary: 'Needs permission: Browser',
          activeRunId: null,
          leaseExpiresAt: null,
          nextAction: 'Approve Browser access, then rerun the job.',
        },
        recovery: {
          state: 'running',
          kind: 'permission_denied',
          updatedAt: iso,
          attempts: 1,
          requirementType: 'tool',
          requirementId: 'Browser',
          nextAction: 'Approve Browser access.',
          lastError: null,
        },
        modelAlias: null,
        model: null,
        workspaceKey: 'app:app-one:session-1',
        sessionId: null,
        toolAccess: {
          inheritedAgentTools: ['Read'],
          effectiveAllowedTools: ['Read'],
          projectedRuntimeTools: [],
          source: 'inherited target agent capabilities',
        },
      }),
    ).toMatchObject({
      staleness: 'missed_window',
      accessRequirements: [
        { target: { kind: 'capability', capabilityId: 'acme.records.append' } },
        { target: { kind: 'tool_rule', rule: 'Browser' } },
      ],
      health: { state: 'needs_permission' },
      recovery: { state: 'running', kind: 'permission_denied' },
    });
    expectInvalid(JobResponseSchema, {
      jobId: 'job-1',
      name: 'Daily summary',
      kind: 'once',
      status: 'active',
      schedule: { type: 'once', runAt: iso },
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
      notificationRoutes: [],
      nextRun: iso,
      lastRun: null,
      modelAlias: null,
      model: null,
      workspaceKey: 'app:app-one:session-1',
      sessionId: null,
      toolAccess: {
        inheritedAgentTools: ['Read'],
        effectiveAllowedTools: ['Read'],
        source: 'inherited target agent capabilities',
      },
      inheritedTools: ['Read'],
    });
    expectInvalid(JobResponseSchema, {
      jobId: 'job-1',
      name: 'Daily summary',
      kind: 'once',
      status: 'active',
      schedule: { type: 'once', runAt: iso },
      executionContext: {
        conversationJid: 'app:app-one:session-1',
        threadId: null,
        workspaceKey: 'app:app-one:session-1',
      },
      notificationRoutes: [],
      nextRun: iso,
      lastRun: null,
      staleness: 'delayed',
      modelAlias: null,
      model: null,
      workspaceKey: 'app:app-one:session-1',
      sessionId: null,
    });
    expectInvalid(JobResponseSchema, {
      jobId: 'job-1',
      name: 'Daily summary',
      kind: 'once',
      status: 'active',
      schedule: { type: 'once', runAt: iso },
      linkedSessions: ['app:app-one:session-1'],
      notificationRoutes: [],
      nextRun: iso,
      lastRun: null,
      modelAlias: null,
      model: null,
      workspaceKey: 'app:app-one:session-1',
      sessionId: null,
      toolAccess: {
        inheritedAgentTools: ['Read'],
        effectiveAllowedTools: ['Read'],
        source: 'inherited target agent capabilities',
      },
    });

    expect(
      MemoryItemResponseSchema.parse({
        id: 'memory-1',
        appId: 'app-1',
        subject: { type: 'common', id: 'common' },
        kind: 'fact',
        key: 'timezone',
        value: 'Asia/Kolkata',
        confidence: 1,
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ key: 'timezone' });
    expectInvalid(MemoryItemResponseSchema, {
      id: 'memory-1',
      appId: 'app-1',
      subject: { type: 'common', id: 'common' },
      kind: 'fact',
      key: 'timezone',
      value: 'Asia/Kolkata',
      confidence: 1.0001,
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    });
    expectInvalid(MemorySearchRequestSchema, { limit: 101 });

    expect(
      BrowserProfileResponseSchema.parse({
        id: 'browser-1',
        appId: 'app-1',
        name: 'default',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ name: 'default' });
    expectInvalid(BrowserProfileResponseSchema, {
      id: 'browser-1',
      appId: 'app-1',
      name: 'default',
      status: 'bad',
      createdAt: iso,
      updatedAt: iso,
    });

    expect(
      ProviderResponseSchema.parse({
        id: 'slack',
        displayName: 'Slack',
        capabilities: ['threads'],
        status: 'available',
        createdAt: iso,
      }),
    ).toMatchObject({ id: 'slack' });
    expect(
      ProviderListResponseSchema.parse({
        providers: [
          {
            id: 'teams',
            displayName: 'Teams',
            capabilities: ['placeholder'],
            status: 'unavailable',
            placeholder: true,
            createdAt: iso,
          },
        ],
      }),
    ).toMatchObject({ providers: [{ id: 'teams' }] });
    expectInvalid(ProviderResponseSchema, {
      id: 'slack',
      displayName: 'Slack',
      capabilities: ['threads'],
    });

    expect(
      ProviderAccountResponseSchema.parse({
        id: 'installation-1',
        appId: 'app-1',
        agentId: 'agent-1',
        providerId: 'slack',
        label: 'Workspace',
        status: 'active',
        config: { teamId: 'T123' },
        runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ providerId: 'slack' });
    expect(
      ProviderAccountListResponseSchema.parse({
        providerAccounts: [
          {
            id: 'installation-1',
            appId: 'app-1',
            agentId: 'agent-1',
            providerId: 'slack',
            label: 'Workspace',
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          },
        ],
      }),
    ).toMatchObject({ providerAccounts: [{ id: 'installation-1' }] });
    expectInvalid(ProviderAccountResponseSchema, {
      id: 'installation-1',
      appId: 'app-1',
      agentId: 'agent-1',
      providerId: 'slack',
      label: 'Workspace',
      status: 'bad',
      createdAt: iso,
      updatedAt: iso,
    });

    expect(
      ConversationInstallRequestSchema.parse({
        providerAccountId: 'installation-1',
        memoryScope: 'conversation',
        routeConfig: { trigger: '/ask', requiresTrigger: true },
        permissionPolicyIds: [],
      }),
    ).toMatchObject({
      providerAccountId: 'installation-1',
      routeConfig: { trigger: '/ask', requiresTrigger: true },
    });
    expectInvalid(ConversationInstallRequestSchema, {
      memoryScope: 'sometimes',
    });
    expect(
      ConversationInstallResponseSchema.parse({
        id: 'install-1',
        appId: 'app-1',
        agentId: 'agent-1',
        providerAccountId: 'installation-1',
        conversationId: 'conversation-1',
        displayName: 'Engineering',
        status: 'active',
        memoryScope: 'conversation',
        routeConfig: { trigger: '/ask', requiresTrigger: true },
        permissionPolicyIds: [],
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({
      status: 'active',
      providerAccountId: 'installation-1',
      routeConfig: { trigger: '/ask', requiresTrigger: true },
    });
    expect(
      ConversationInstallListResponseSchema.parse({
        conversationInstalls: [
          {
            id: 'install-1',
            appId: 'app-1',
            agentId: 'agent-1',
            providerAccountId: 'installation-1',
            conversationId: 'conversation-1',
            displayName: 'Engineering',
            status: 'disabled',
            memoryScope: 'app',
            permissionPolicyIds: ['policy-1'],
            createdAt: iso,
            updatedAt: iso,
          },
        ],
      }),
    ).toMatchObject({ conversationInstalls: [{ status: 'disabled' }] });

    expect(
      ConversationResponseSchema.parse({
        id: 'conversation-1',
        appId: 'app-1',
        providerAccountId: 'installation-1',
        kind: 'channel',
        title: 'Engineering',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ kind: 'channel' });
    expect(
      ConversationListResponseSchema.parse({
        conversations: [
          {
            id: 'conversation-1',
            appId: 'app-1',
            providerAccountId: 'installation-1',
            kind: 'dm',
            title: null,
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          },
        ],
      }),
    ).toMatchObject({ conversations: [{ kind: 'dm' }] });
    expect(
      ConversationThreadResponseSchema.parse({
        id: 'thread-1',
        appId: 'app-1',
        conversationId: 'conversation-1',
        title: 'Deploy',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ id: 'thread-1' });
    expect(
      ConversationThreadListResponseSchema.parse({
        threads: [
          {
            id: 'thread-1',
            appId: 'app-1',
            conversationId: 'conversation-1',
            title: null,
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          },
        ],
      }),
    ).toMatchObject({ threads: [{ id: 'thread-1' }] });
    expect(
      MessageListResponseSchema.parse({ messages: [message] }),
    ).toMatchObject({
      messages: [{ id: 'message-1', providerAccountId: 'provider-account-1' }],
    });
    expect(
      (MessageResponseSchema.parse(message) as Record<string, unknown>)[
        ['provider', 'ConnectionId'].join('')
      ],
    ).toBeUndefined();
    expect(
      PersonAliasResponseSchema.parse({
        id: 'alias-1',
        appId: 'app-1',
        personId: 'person-1',
        provider: 'slack',
        providerAccountId: 'provider-account-1',
        externalUserId: 'U123',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ providerAccountId: 'provider-account-1' });

    expectInvalid(MessageResponseSchema, {
      ...message,
      parts: [{ ordinal: -1, kind: 'text', payload: { text: 'hello' } }],
    });
  });

  it('validates pagination request and response schema constraints', () => {
    expect(PageRequestSchema.parse({ page: 1, pageSize: 25 })).toEqual({
      page: 1,
      pageSize: 25,
    });
    expectInvalid(PageRequestSchema, { page: 0 });
    expectInvalid(PageRequestSchema, { page: 1, pageSize: 501 });

    const pageResponse = createPageResponseSchema(AgentResponseSchema);
    expect(
      pageResponse.parse({
        data: [
          {
            id: 'agent-1',
            appId: 'app-1',
            name: 'Operator',
            status: 'active',
            agentHarness: 'deepagents',
            createdAt: iso,
            updatedAt: iso,
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
        hasNext: false,
      }),
    ).toMatchObject({ page: 1, hasNext: false });
    expectInvalid(pageResponse, {
      data: [],
      page: 0,
      pageSize: 25,
      hasNext: false,
    });
    expectInvalid(pageResponse, { data: [], page: 1, pageSize: 25 });
    expectInvalid(pageResponse, {
      data: [{ id: 'agent-1' }],
      page: 1,
      pageSize: 25,
      hasNext: false,
    });

    const cursorResponse = createCursorPageResponseSchema(AgentResponseSchema);
    expect(
      cursorResponse.parse({
        data: [],
        nextCursor: 'next',
        hasNext: true,
      }),
    ).toMatchObject({ hasNext: true });
    expectInvalid(cursorResponse, { data: [] });
    expectInvalid(cursorResponse, {
      data: [{ id: 'agent-1' }],
      hasNext: false,
    });
  });

  it.each([
    ['manual', { type: 'manual' }],
    ['once', { type: 'once', runAt: iso }],
    ['cron', { type: 'cron', value: '0 9 * * *' }],
    ['interval', { type: 'interval', value: '60000' }],
  ])('validates %s job schedules', (_name, schedule) => {
    expect(JobScheduleSchema.parse(schedule)).toEqual(schedule);
  });

  it.each([
    ['once without runAt', { type: 'once' }],
    ['once with naive runAt', { type: 'once', runAt: '2026-04-27T00:00:00' }],
    ['cron with empty value', { type: 'cron', value: '' }],
    ['interval with empty value', { type: 'interval', value: '' }],
  ])('rejects invalid job schedule: %s', (_name, schedule) => {
    expectInvalid(JobScheduleSchema, schedule);
  });

  it.each([
    ['heartbeat', { type: 'heartbeat', id: 'event-1', createdAt: iso }, {}],
    [
      'run.event',
      { type: 'run.event', event: runEvent },
      { type: 'run.event' },
    ],
    [
      'message.delta',
      { type: 'message.delta', messageId: 'message-1', delta: 'hello' },
      { type: 'message.delta', messageId: 'message-1' },
    ],
    [
      'message.completed',
      { type: 'message.completed', message },
      { type: 'message.completed' },
    ],
    [
      'progress',
      { type: 'progress', label: 'Running', detail: 'Step 1', done: false },
      { type: 'progress', detail: 'Step 1' },
    ],
    [
      'tool.requested',
      { type: 'tool.requested', toolCallId: 'call-1', name: 'search' },
      { type: 'tool.requested', name: 'search' },
    ],
    [
      'tool.completed',
      { type: 'tool.completed', toolCallId: 'call-1', output: { ok: true } },
      { type: 'tool.completed', output: { ok: true } },
    ],
    [
      'permission.decision',
      { type: 'permission.decision', decision: permissionDecision },
      { type: 'permission.decision' },
    ],
    [
      'error',
      { type: 'error', error: { code: 'INVALID_REQUEST', message: 'Nope' } },
      { type: 'error' },
    ],
    [
      'completed',
      { type: 'completed', status: 'completed', resultSummary: 'Done' },
      { type: 'completed' },
    ],
  ])('validates stream event variant %s', (_name, valid, invalid) => {
    expect(StreamEventSchema.parse(valid)).toMatchObject(valid);
    if (Object.keys(invalid).length > 0) {
      expectInvalid(StreamEventSchema, invalid);
    }
  });
});

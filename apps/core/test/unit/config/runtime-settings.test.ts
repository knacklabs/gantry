import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createDefaultRuntimeSettings,
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  mirrorAgentToolRulesToRuntimeSettings,
  parseRuntimeSettings,
  saveRuntimeSettings,
  withRuntimeModelAliases,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { validateLoadedRuntimeSettings } from '@core/config/settings/runtime-settings-validation.js';
import { settingsFilePath } from '@core/config/settings/runtime-home.js';
import { addActiveMcpSourcesToRuntimeSettings } from '@core/config/settings/restart-sync.js';
import { runSettingsCommand } from '@core/cli/settings.js';

function emptySources() {
  return { skills: [], mcpServers: [], tools: [] };
}

describe('runtime settings', () => {
  it('adds active MCP source refs before desired-state mirroring reconciles settings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'ReAgent',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [{ id: 'mcp.caw-ats.access', version: '1' }],
    };

    await addActiveMcpSourcesToRuntimeSettings({
      settings,
      agentFolder: 'main_agent',
      appId: 'default' as never,
      repositories: {
        mcpServers: {
          listAgentBindings: vi.fn(async () => [
            {
              appId: 'default',
              agentId: 'agent:main_agent',
              id: 'agent-mcp-binding:agent:main_agent:mcp:caw-ats',
              serverId: 'mcp:caw-ats',
              status: 'active',
              required: false,
              permissionPolicyIds: [],
              allowedToolPatterns: ['ats_list_positions'],
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          ]),
        } as never,
      },
    });

    expect(settings.agents.main_agent.sources.mcpServers).toEqual([
      { id: 'mcp:caw-ats', tools: ['ats_list_positions'] },
    ]);
  });

  it('defaults, renders, and parses agent.name', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.agent.name).toBe('Default Agent');

    settings.agent.name = 'Kai';
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('name: Kai');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agent.name).toBe('Kai');
  });

  it('A7: parses numeric loopback gateway bind hosts', () => {
    for (const host of ['127.0.0.1', '::1']) {
      const parsed = parseRuntimeSettings(
        `model_access:\n  gateway:\n    bind_host: '${host}'\n`,
      );
      expect(parsed.credentialBroker.gateway.bindHost).toBe(host);
    }
  });

  it('A7: rejects a non-numeric gateway bind host (parity with the broker)', () => {
    // The gateway broker only binds numeric loopback and crashes at startup
    // otherwise; reject 'localhost' at config time with a clear error.
    expect(() =>
      parseRuntimeSettings(
        `model_access:\n  gateway:\n    bind_host: localhost\n`,
      ),
    ).toThrow('must be a numeric loopback host: 127.0.0.1 or ::1');
  });

  it('defaults, renders, and parses job model defaults', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agent.defaultModel = 'sonnet';
    settings.agent.oneTimeJobDefaultModel = 'kimi';
    settings.agent.recurringJobDefaultModel = 'opus-4.6';

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('one_time_model: kimi');
    expect(yaml).toContain('recurring_model: opus-4.6');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agent.defaultModel).toBe('sonnet');
    expect(parsed.agent.oneTimeJobDefaultModel).toBe('kimi');
    expect(parsed.agent.recurringJobDefaultModel).toBe('opus-4.6');
  });

  it('round-trips per-agent mcp tool scope through settings.yaml', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [],
        mcpServers: [{ id: 'github', tools: ['read_*'] }],
        tools: [],
      },
      capabilities: [],
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('mcp_servers:');
    expect(yaml).toContain('tools:');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agents.main_agent.sources.mcpServers).toEqual([
      { id: 'github', tools: ['read_*'] },
    ]);
  });

  it('rejects tool scope on non-mcp source refs', () => {
    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    access:
      sources:
        skills:
          - id: demo
            tools:
              - read_*
`),
    ).toThrow(/tools is only supported for mcp_servers/);
  });

  it('defaults, renders, and parses runtime queue policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.runtime.queue).toEqual({
      maxMessageRuns: 3,
      maxJobRuns: 4,
      maxMessageBacklog: 0,
      maxTaskBacklog: 0,
      maxRetries: 5,
      baseRetryMs: 5000,
      drainDeadlineMs: 120000,
    });

    settings.runtime.queue = {
      maxMessageRuns: 6,
      maxJobRuns: 2,
      maxMessageBacklog: 7,
      maxTaskBacklog: 9,
      maxRetries: 1,
      baseRetryMs: 250,
      drainDeadlineMs: 45000,
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('runtime:');
    expect(yaml).toContain('max_message_runs: 6');
    expect(yaml).toContain('max_job_runs: 2');
    expect(yaml).toContain('max_message_backlog: 7');
    expect(yaml).toContain('max_task_backlog: 9');
    expect(yaml).toContain('max_retries: 1');
    expect(yaml).toContain('base_retry_ms: 250');
    expect(yaml).toContain('drain_deadline_ms: 45000');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.queue).toEqual(settings.runtime.queue);
  });

  it('defaults model_families to empty and omits the block when empty', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.modelFamilies).toEqual({});
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).not.toContain('model_families');
    expect(parseRuntimeSettings(yaml).modelFamilies).toEqual({});
  });

  it('renders and round-trips a model_families order override', () => {
    const settings = createDefaultRuntimeSettings();
    settings.modelFamilies = {
      'gpt-oss': ['cerebras', 'groq-oss'],
      'llama-70b': ['together'],
    };
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('model_families:');
    expect(yaml).toContain('gpt-oss: ["cerebras","groq-oss"]');
    expect(yaml).toContain('llama-70b: ["together"]');
    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.modelFamilies).toEqual(settings.modelFamilies);
  });

  it('renders, parses, and uses custom model aliases for agent models', () => {
    const settings = createDefaultRuntimeSettings();
    settings.modelAliases = {
      'fast-job': {
        provider: 'groq',
        providerModelId: 'llama-3.1-8b-instant',
        displayName: 'Fast Job Model',
        aliases: ['fast-job'],
        recommendedAlias: 'fast-job',
        supportedWorkloads: ['chat', 'one_time_job', 'recurring_job'],
        contextWindowTokens: 131_072,
        inputUsdPerMillionTokens: 0.05,
        outputUsdPerMillionTokens: 0.08,
        supportsTools: true,
        source: {
          label: 'Groq supported models',
          url: 'https://console.groq.com/docs/models',
          verifiedAt: '2026-06-19',
        },
      },
    };
    settings.agents.worker = {
      name: 'Worker',
      folder: 'worker',
      model: 'fast-job',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('model_aliases:');
    expect(yaml).toContain('provider_model_id: "llama-3.1-8b-instant"');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.modelAliases['fast-job']).toMatchObject({
      provider: 'groq',
      providerModelId: 'llama-3.1-8b-instant',
    });
    expect(parsed.agents.worker.model).toBe('fast-job');
    const validation = withRuntimeModelAliases(parsed, () =>
      validateLoadedRuntimeSettings('/tmp/gantry-custom-model', parsed),
    );
    expect(validation.failure?.details.join('\n') ?? '').not.toContain(
      'agents.worker.model is invalid',
    );
  });

  it('rejects invalid custom model alias providers', () => {
    expect(() =>
      parseRuntimeSettings(`model_aliases:
  missing:
    provider: not-a-provider
    provider_model_id: model-id
`),
    ).toThrow(/Model credential provider must be one of/);
  });

  it('keeps custom model tool support unknown unless declared', () => {
    const parsed = parseRuntimeSettings(`model_aliases:
  no-tools-claim:
    provider: groq
    provider_model_id: llama-3.1-8b-instant
`);

    expect(
      parsed.modelAliases['no-tools-claim']?.supportsTools,
    ).toBeUndefined();
  });

  it('rejects a non-array model_families value', () => {
    expect(() =>
      parseRuntimeSettings('model_families:\n  gpt-oss: not-an-array\n'),
    ).toThrow(/model_families\.gpt-oss must be a string array/);
  });

  it('keeps harness/provider internals out of the rendered settings.yaml', () => {
    const settings = createDefaultRuntimeSettings();
    const yaml = renderRuntimeSettingsYaml(settings);
    for (const token of [
      'permissionMode',
      'executionProviderId',
      'mcpServers',
      'disallowedTools',
      'LocalShellBackend',
      'interrupt_on',
      'harness:',
    ]) {
      expect(yaml, `settings.yaml must not render ${token}`).not.toContain(
        token,
      );
    }
  });

  it('defaults, renders, and parses live-turn host policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.runtime.liveTurns).toEqual({ enabled: true });

    settings.runtime.liveTurns = { enabled: false };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('live_turns:');
    expect(yaml).toContain('enabled: false');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.liveTurns).toEqual(settings.runtime.liveTurns);
  });

  it('defaults, renders, and parses runner sandbox policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.runtime.sandbox).toEqual({
      provider: 'direct',
      resourceLimits: {
        cpuSeconds: 0,
        memoryMb: 0,
        maxProcesses: 0,
      },
    });

    settings.runtime.sandbox = {
      provider: 'sandbox_runtime',
      resourceLimits: {
        cpuSeconds: 120,
        memoryMb: 2048,
        maxProcesses: 64,
      },
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('sandbox:');
    expect(yaml).toContain('provider: sandbox_runtime');
    expect(yaml).toContain('cpu_seconds: 120');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.sandbox).toEqual(settings.runtime.sandbox);
  });

  it('defaults, renders, and parses neutral browser usage policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.browser.usage).toEqual({
      enabled: false,
      mode: 'audit',
      windowMs: 60_000,
      maxActionsPerWindow: 120,
      maxConcurrentPerSite: 1,
      overrides: {},
    });

    settings.browser.usage = {
      enabled: true,
      mode: 'audit',
      windowMs: 30_000,
      maxActionsPerWindow: 10,
      maxConcurrentPerSite: 1,
      overrides: {
        'example.com': {
          mode: 'enforce',
          maxActionsPerWindow: 3,
        },
      },
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('browser:');
    expect(yaml).toContain('enabled: true');
    expect(yaml).toContain('"example.com":');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.browser.usage).toEqual({
      ...settings.browser.usage,
    });
  });

  it('defaults, renders, and parses YOLO-mode permission policy additions', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.permissions.yoloMode).toEqual({
      enabled: true,
      denylist: [],
      denylistPaths: [],
    });
    expect(settings.permissions.egress).toEqual({
      denylist: [],
    });

    settings.permissions.yoloMode = {
      enabled: true,
      denylist: ['npm run nuke'],
      denylistPaths: ['/opt/danger/*'],
    };
    settings.permissions.egress = {
      denylist: ['api.linkedin.com', '*.blocked.example.com'],
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('permissions:');
    expect(yaml).toContain('yolo_mode:');
    expect(yaml).toContain('egress:');
    expect(yaml).toContain('npm run nuke');
    expect(yaml).toContain('api.linkedin.com');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.permissions).toEqual(settings.permissions);
  });

  it('rejects unsupported YOLO-mode permission keys', () => {
    expect(() =>
      parseRuntimeSettings(`permissions:
  yolo_mode:
    enabled: true
    allowlist: []
`),
    ).toThrow('permissions.yolo_mode.allowlist is not supported');
  });

  it('rejects unsupported egress permission keys', () => {
    expect(() =>
      parseRuntimeSettings(`permissions:
  egress:
    allowlist: []
`),
    ).toThrow('permissions.egress.allowlist is not supported');
  });

  it('rejects invalid egress denylist hostname globs', () => {
    expect(() =>
      parseRuntimeSettings(`permissions:
  egress:
    denylist: ["api_example.com"]
`),
    ).toThrow(
      'permissions.egress.denylist[0] must be a hostname glob such as api.example.com or *.example.com',
    );
  });

  it('canonicalizes egress denylist hostname globs', () => {
    const parsed = parseRuntimeSettings(`permissions:
  egress:
    denylist: ["API.LinkedIn.Com."]
`);

    expect(parsed.permissions.egress.denylist).toEqual(['api.linkedin.com']);
  });

  it('canonicalizes browser usage override site keys', () => {
    const parsed = parseRuntimeSettings(`browser:
  usage:
    enabled: true
    overrides:
      app.example.co.uk:
        mode: enforce
        max_actions_per_window: 3
`);
    expect(parsed.browser.usage.overrides).toEqual({
      'example.co.uk': {
        mode: 'enforce',
        maxActionsPerWindow: 3,
      },
    });
    expect(renderRuntimeSettingsYaml(parsed)).toContain('"example.co.uk":');
  });

  it('rejects unsupported browser usage keys', () => {
    expect(() =>
      parseRuntimeSettings(`browser:
  usage:
    enabled: false
    website_rules: {}
`),
    ).toThrow('browser.usage.website_rules is not supported');
  });

  it('rejects browser usage overrides that normalize to duplicate site keys', () => {
    expect(() =>
      parseRuntimeSettings(`browser:
  usage:
    enabled: true
    overrides:
      example.com:
        mode: audit
      app.example.com:
        mode: enforce
`),
    ).toThrow('normalizes to duplicate site key example.com');
  });

  it('rejects unsupported runtime queue keys', () => {
    expect(() =>
      parseRuntimeSettings(`runtime:
  queue:
    max_message_runs: 3
    max_jobb_runs: 4
`),
    ).toThrow('runtime.queue.max_jobb_runs is not supported');
  });

  it('rejects unsupported live-turn host keys', () => {
    expect(() =>
      parseRuntimeSettings(`runtime:
  live_turns:
    horizontal: true
`),
    ).toThrow('runtime.live_turns.horizontal is not supported');
  });

  it('rejects negative runtime queue backlog caps', () => {
    expect(() =>
      parseRuntimeSettings(`runtime:
  queue:
    max_message_backlog: -1
`),
    ).toThrow(
      'runtime.queue.max_message_backlog must be a non-negative integer',
    );

    expect(() =>
      parseRuntimeSettings(`runtime:
  queue:
    max_task_backlog: -1
`),
    ).toThrow('runtime.queue.max_task_backlog must be a non-negative integer');
  });

  it('rejects unsupported runtime sandbox keys', () => {
    expect(() =>
      parseRuntimeSettings(`runtime:
  sandbox:
    provider: unsandboxed
`),
    ).toThrow('runtime.sandbox.provider must be direct or sandbox_runtime');
  });

  it('rejects duplicate settings keys before schema normalization', () => {
    expect(() =>
      parseRuntimeSettings(`agent:
  name: Kai
agent:
  name: Other
`),
    ).toThrow('duplicate key "agent" (line 3)');

    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    name: Other
`),
    ).toThrow('duplicate key "name" (line 4)');
  });

  it('validates settings.yaml schema without runtime preflight dependencies', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-validate-'),
    );
    try {
      saveRuntimeSettings(runtimeHome, createDefaultRuntimeSettings());
      await expect(runSettingsCommand(runtimeHome, ['validate'])).resolves.toBe(
        0,
      );

      fs.writeFileSync(
        settingsFilePath(runtimeHome),
        ['agent:', '  name: Kai', 'agent:', '  name: Other', ''].join('\n'),
      );
      await expect(runSettingsCommand(runtimeHome, ['validate'])).resolves.toBe(
        1,
      );
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('accepts credential encryption keyring without direct encryption key', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    const originalSecretEncryptionKeyring =
      process.env.SECRET_ENCRYPTION_KEYRING_JSON;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-keyring-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      delete process.env.SECRET_ENCRYPTION_KEY;
      process.env.SECRET_ENCRYPTION_KEYRING_JSON = JSON.stringify({
        active: 'primary',
        keys: {
          primary: Buffer.from(
            '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
            'hex',
          ).toString('base64'),
        },
      });

      const settings = createDefaultRuntimeSettings();
      saveRuntimeSettings(runtimeHome, settings);

      expect(
        validateLoadedRuntimeSettings(runtimeHome, settings),
      ).toMatchObject({
        ok: true,
      });
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSecretEncryptionKey === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEY;
      } else {
        process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
      }
      if (originalSecretEncryptionKeyring === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEYRING_JSON;
      } else {
        process.env.SECRET_ENCRYPTION_KEYRING_JSON =
          originalSecretEncryptionKeyring;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects unsupported agent settings keys', () => {
    const settings = createDefaultRuntimeSettings();
    const yaml = renderRuntimeSettingsYaml(settings).replace(
      '  model:',
      '  raw_env: true\n  model:',
    );
    expect(() => parseRuntimeSettings(yaml)).toThrow(
      'defaults.raw_env is not supported',
    );
  });

  it('rejects malformed compact default maps', () => {
    expect(() =>
      parseRuntimeSettings(`defaults:
  model: opus
  jobs: sonnet
`),
    ).toThrow('defaults.jobs must be a mapping');

    expect(() =>
      parseRuntimeSettings(`defaults:
  model: opus
  sessions: enabled
`),
    ).toThrow('defaults.sessions must be a mapping');
  });

  it('rejects malformed compact agent job maps', () => {
    expect(() =>
      parseRuntimeSettings(`defaults:
  model: opus

agents:
  kai:
    name: Kai
    jobs: sonnet
`),
    ).toThrow('agents.kai.jobs must be a mapping');
  });

  it('rejects unsupported compact provider, conversation, and job keys', () => {
    expect(() =>
      parseRuntimeSettings(`providers:
  telegram:
    enabled: true
    bot_token_en: TELEGRAM_BOT_TOKEN
`),
    ).toThrow('providers.telegram.bot_token_en is not supported');

    expect(() =>
      parseRuntimeSettings(`agents:
  kai:
    name: Kai
    jobs:
      one_tim_model: sonnet
`),
    ).toThrow('agents.kai.jobs.one_tim_model is not supported');

    expect(() =>
      parseRuntimeSettings(`conversations:
  kai:
    provider: telegram
    id: "123"
    type: channel
    aproverz: ["42"]
`),
    ).toThrow('conversations.kai.aproverz is not supported');
  });

  it('rejects unsupported nested memory settings keys', () => {
    expect(() =>
      parseRuntimeSettings(`memory:
  enabled: true
  embeddings:
    enabled: true
    provider: openai
    modell: text-embedding-3-small
`),
    ).toThrow('memory.embeddings.modell is not supported');

    expect(() =>
      parseRuntimeSettings(`memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-small
  dreaming:
    enabld: true
`),
    ).toThrow('memory.dreaming.enabld is not supported');

    expect(() =>
      parseRuntimeSettings(`memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-small
  llm:
    modelz: {}
`),
    ).toThrow('memory.llm.modelz is not supported');

    expect(() =>
      parseRuntimeSettings(`memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-small
  llm:
    models:
      extractorr: sonnet
`),
    ).toThrow('memory.llm.models.extractorr is not supported');
  });

  it('parses settings-owned memory tuning knobs', () => {
    const parsed = parseRuntimeSettings(`memory:
  enabled: true
  embeddings:
    enabled: true
    provider: openai
    model: text-embedding-3-small
    daily_limit: 42
    batch_size: 7
  dreaming:
    enabled: true
    cron: "*/15 * * * *"
    embeddings:
      enabled: true
      provider: openai
      model: text-embedding-3-small
  llm:
    extractor_max_facts: 5
    extractor_min_confidence: 0.75
    models:
      extractor: haiku
      dreaming: sonnet
      consolidation: sonnet
  maintenance:
    max_pending: 250
`);

    expect(parsed.memory.embeddings.dailyLimit).toBe(42);
    expect(parsed.memory.embeddings.batchSize).toBe(7);
    expect(parsed.memory.dreaming.cron).toBe('*/15 * * * *');
    expect(parsed.memory.dreaming.embeddings).toEqual({
      enabled: true,
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
    expect(parsed.memory.llm.extractorMaxFacts).toBe(5);
    expect(parsed.memory.llm.extractorMinConfidence).toBe(0.75);
    expect(parsed.memory.maintenance.maxPending).toBe(250);
  });

  it('rejects unsupported semantic memory vector dimensions', () => {
    expect(() =>
      parseRuntimeSettings(`memory:
  enabled: true
  embeddings:
    enabled: true
    provider: openai
    model: text-embedding-3-small
    dimensions: 3072
`),
    ).toThrow(
      'memory.embeddings.dimensions must be 1536; Gantry semantic memory v1 stores vector(1536) only.',
    );
  });

  it('rejects non-embedding providers for memory embeddings', () => {
    expect(() =>
      parseRuntimeSettings(`memory:
  enabled: true
  embeddings:
    enabled: true
    provider: anthropic
    model: text-embedding-3-small
`),
    ).toThrow('memory.embeddings.provider must be one of disabled, openai.');
  });

  it('keeps explicit verbose provider connections over compact defaults', () => {
    const parsed = parseRuntimeSettings(`providers:
  telegram:
    enabled: true
    label: Compact Telegram
    bot_token_ref: TELEGRAM_COMPACT_BOT_TOKEN

provider_connections:
  telegram_default:
    provider: telegram
    label: Explicit Telegram
    runtime_secret_refs:
      bot_token: TELEGRAM_EXPLICIT_BOT_TOKEN
`);

    expect(parsed.providerConnections.telegram_default).toMatchObject({
      label: 'Explicit Telegram',
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_EXPLICIT_BOT_TOKEN' },
    });
  });

  it('rejects compact provider env keys', () => {
    expect(() =>
      parseRuntimeSettings(`providers:
  telegram:
    enabled: true
    bot_token_env: TELEGRAM_BOT_TOKEN
`),
    ).toThrow('providers.telegram.bot_token_env is not supported');
  });

  it('accepts durable provider connection ids exported from runtime storage', () => {
    const parsed = parseRuntimeSettings(`providers:
  telegram:
    enabled: true

provider_connections:
  "channel-providerConnection:default:telegram":
    provider: telegram
    label: Telegram

conversations:
  main_telegram_group:
    provider_connection: "channel-providerConnection:default:telegram"
    external_id: "telegram:-1003986348737"
    type: channel
    agent: main_agent

agents:
  main_agent:
    name: "Main Agent"
`);

    expect(
      parsed.providerConnections['channel-providerConnection:default:telegram'],
    ).toMatchObject({
      provider: 'telegram',
      label: 'Telegram',
    });
    expect(parsed.conversations.main_telegram_group.providerConnection).toBe(
      'channel-providerConnection:default:telegram',
    );
  });

  it('accepts opaque provider connection ids used by control APIs', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true

provider_connections:
  "providerConnection/1":
    provider: slack
    label: Slack

conversations:
  team:
    provider_connection: "providerConnection/1"
    external_id: "slack:C123"
    type: channel
    agent: main_agent

agents:
  main_agent:
    name: "Main Agent"
`);

    expect(parsed.providerConnections['providerConnection/1']).toMatchObject({
      provider: 'slack',
      label: 'Slack',
    });
    expect(parsed.conversations.team.providerConnection).toBe(
      'providerConnection/1',
    );
  });

  it('validates model defaults against the model catalog', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agent.defaultModel = 'claude-opus-4-7';
    settings.agent.oneTimeJobDefaultModel = 'sonet';

    const result = validateLoadedRuntimeSettings(
      '/tmp/gantry-missing',
      settings,
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'agent.default_model is invalid: Provider model ID "claude-opus-4-7" is not accepted here.',
    );
    expect(result.failure?.details.join('\n')).toContain(
      'agent.one_time_job_default_model is invalid: Unknown model "sonet". Did you mean "sonnet"?',
    );
  });

  it('rejects desired-state external ids whose explicit prefix mismatches provider connection', () => {
    expect(() =>
      parseRuntimeSettings(`providers:
  slack:
    enabled: true
    bot_token_ref: SLACK_BOT_TOKEN

provider_connections:
  slack_default:
    provider: slack
    runtime_secret_refs:
      bot_token: SLACK_BOT_TOKEN

conversations:
  team:
    provider_connection: slack_default
    external_id: "tg:-100123"
    kind: channel
`),
    ).toThrow(
      'conversations.team.external_id uses explicit provider prefix "telegram:" that does not match provider connection "slack".',
    );
  });

  it('flags mismatched explicit conversation prefixes during runtime validation', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.conversations.team = {
      providerConnection: 'slack_default',
      externalId: 'tg:-100123',
      kind: 'channel',
      displayName: 'Team',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['U123'],
    };

    const result = validateLoadedRuntimeSettings(
      '/tmp/gantry-prefix-validation',
      settings,
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'conversations.team.external_id prefix "telegram:" does not match provider connection slack_default (slack).',
    );
  });

  it('accepts enabled providers with stored runtime secret refs', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-provider-secret-validation-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      process.env.SECRET_ENCRYPTION_KEY = Buffer.from(
        '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
        'hex',
      ).toString('base64');
      delete process.env.TELEGRAM_BOT_TOKEN;

      const settings = createDefaultRuntimeSettings();
      settings.providers.telegram.enabled = true;
      settings.providers.telegram.defaultConnection = 'telegram_default';
      settings.providerConnections.telegram_default = {
        provider: 'telegram',
        label: 'Telegram Default',
        runtimeSecretRefs: { bot_token: 'gantry-secret:TELEGRAM_BOT_TOKEN' },
      };

      expect(
        validateLoadedRuntimeSettings(runtimeHome, settings),
      ).toMatchObject({
        ok: true,
      });
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSecretEncryptionKey === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEY;
      } else {
        process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
      }
      if (originalTelegramBotToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = originalTelegramBotToken;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('requires an encryption key for enabled provider stored runtime secret refs', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-provider-secret-validation-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      delete process.env.SECRET_ENCRYPTION_KEY;

      const settings = createDefaultRuntimeSettings();
      settings.credentialBroker.mode = 'none';
      settings.providers.telegram.enabled = true;
      settings.providers.telegram.defaultConnection = 'telegram_default';
      settings.providerConnections.telegram_default = {
        provider: 'telegram',
        label: 'Telegram Default',
        runtimeSecretRefs: { bot_token: 'gantry-secret:TELEGRAM_BOT_TOKEN' },
      };

      const result = validateLoadedRuntimeSettings(runtimeHome, settings);

      expect(result.ok).toBe(false);
      expect(result.failure?.details.join('\n')).toContain(
        'SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON must provide',
      );
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSecretEncryptionKey === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEY;
      } else {
        process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('accepts AWS Secrets Manager provider refs with deployment-owned names', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-provider-secret-aws-ref-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      process.env.SECRET_ENCRYPTION_KEY = Buffer.from(
        '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
        'hex',
      ).toString('base64');

      const settings = createDefaultRuntimeSettings();
      settings.providers.telegram.enabled = true;
      settings.providers.telegram.defaultConnection = 'telegram_default';
      settings.providerConnections.telegram_default = {
        provider: 'telegram',
        label: 'Telegram Default',
        runtimeSecretRefs: { bot_token: 'aws-sm:prod/telegram/bot' },
      };

      expect(
        validateLoadedRuntimeSettings(runtimeHome, settings),
      ).toMatchObject({
        ok: true,
      });
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSecretEncryptionKey === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEY;
      } else {
        process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('accepts configured provider refs before env fallback', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-provider-secret-validation-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      process.env.SECRET_ENCRYPTION_KEY = Buffer.from(
        '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
        'hex',
      ).toString('base64');
      process.env.TELEGRAM_BOT_TOKEN = 'legacy-env-token';

      const settings = createDefaultRuntimeSettings();
      settings.providers.telegram.enabled = true;
      settings.providers.telegram.defaultConnection = 'telegram_default';
      settings.providerConnections.telegram_default = {
        provider: 'telegram',
        label: 'Telegram Default',
        runtimeSecretRefs: {
          bot_token: 'gantry-secret:CUSTOM_TELEGRAM_BOT_TOKEN',
        },
      };

      const result = validateLoadedRuntimeSettings(runtimeHome, settings);

      expect(result.ok).toBe(true);
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSecretEncryptionKey === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEY;
      } else {
        process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
      }
      if (originalTelegramBotToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = originalTelegramBotToken;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('accepts provider env refs that use custom variable names', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    const originalCustomTelegramBotToken =
      process.env.CUSTOM_TELEGRAM_BOT_TOKEN;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-provider-secret-validation-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      process.env.SECRET_ENCRYPTION_KEY = Buffer.from(
        '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
        'hex',
      ).toString('base64');
      process.env.CUSTOM_TELEGRAM_BOT_TOKEN = 'custom-token';

      const settings = createDefaultRuntimeSettings();
      settings.providers.telegram.enabled = true;
      settings.providers.telegram.defaultConnection = 'telegram_default';
      settings.providerConnections.telegram_default = {
        provider: 'telegram',
        label: 'Telegram Default',
        runtimeSecretRefs: { bot_token: 'env:CUSTOM_TELEGRAM_BOT_TOKEN' },
      };

      const result = validateLoadedRuntimeSettings(runtimeHome, settings);

      expect(result.ok).toBe(true);
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSecretEncryptionKey === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEY;
      } else {
        process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
      }
      if (originalCustomTelegramBotToken === undefined) {
        delete process.env.CUSTOM_TELEGRAM_BOT_TOKEN;
      } else {
        process.env.CUSTOM_TELEGRAM_BOT_TOKEN = originalCustomTelegramBotToken;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects provider env refs that use model credential authority names', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-provider-secret-validation-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      process.env.SECRET_ENCRYPTION_KEY = Buffer.from(
        '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
        'hex',
      ).toString('base64');
      process.env.OPENAI_API_KEY = 'wrong-lane-token';

      const settings = createDefaultRuntimeSettings();
      settings.providers.telegram.enabled = true;
      settings.providers.telegram.defaultConnection = 'telegram_default';
      settings.providerConnections.telegram_default = {
        provider: 'telegram',
        label: 'Telegram Default',
        runtimeSecretRefs: { bot_token: 'env:OPENAI_API_KEY' },
      };

      const result = validateLoadedRuntimeSettings(runtimeHome, settings);

      expect(result.ok).toBe(false);
      expect(result.failure?.details.join('\n')).toContain(
        "OPENAI_API_KEY is not allowed for provider 'telegram' runtime secret ref env:OPENAI_API_KEY.",
      );
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalSecretEncryptionKey === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEY;
      } else {
        process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
      }
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('renders and parses local desired-state agents', () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Default Agent',
      folder: 'main_agent',
      persona: 'generalist',
      relationshipMode: 'organization',
      model: 'sonnet',
      oneTimeJobDefaultModel: 'haiku',
      recurringJobDefaultModel: 'opus',
      bindings: {},
      sources: {
        skills: [{ id: 'skill:admin' }],
        mcpServers: [{ id: 'mcp:github' }],
        tools: [],
      },
      capabilities: [{ id: 'Read', version: 'builtin' }],
    };
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.main_dm = {
      providerConnection: 'telegram_default',
      externalId: '100',
      kind: 'dm',
      displayName: 'Main DM',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['42'],
    };
    settings.bindings.primary = {
      agent: 'main_agent',
      conversation: 'main_dm',
      trigger: '@kai',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: false,
      memoryScope: 'conversation',
    };

    const parsed = parseRuntimeSettings(renderRuntimeSettingsYaml(settings));

    expect(parsed.desiredState.authoritative).toBe(true);
    expect(parsed.agents.main_agent.persona).toBe('generalist');
    expect(parsed.agents.main_agent.relationshipMode).toBe('organization');
    expect(renderRuntimeSettingsYaml(parsed)).toContain(
      '    persona: generalist',
    );
    expect(renderRuntimeSettingsYaml(parsed)).toContain(
      '    relationship_mode: organization',
    );
    expect(parsed.agents.main_agent.bindings.main_dm).toMatchObject({
      jid: 'tg:100',
      provider: 'telegram',
      name: 'Main DM',
      trigger: '@kai',
      requiresTrigger: false,
    });
    expect(parsed.bindings.main_dm).toMatchObject({
      agent: 'main_agent',
      conversation: 'main_dm',
      trigger: '@kai',
      requiresTrigger: false,
      memoryScope: 'conversation',
    });
  });

  it('renders agent_harness and rejects the retired agent_engine key', () => {
    const settings = createDefaultRuntimeSettings();
    expect(renderRuntimeSettingsYaml(settings)).not.toContain('agent_engine');
    expect(settings.agent.agentHarness).toBe('auto');

    settings.agent.agentHarness = 'deepagents';
    settings.agents.kai = {
      name: 'Kai',
      folder: 'kai',
      agentHarness: 'anthropic_sdk',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    const rendered = renderRuntimeSettingsYaml(settings);
    expect(rendered).toContain('agent_harness: deepagents');
    expect(rendered).toContain('agent_harness: anthropic_sdk');
    const parsed = parseRuntimeSettings(rendered);
    expect(parsed.agent.agentHarness).toBe('deepagents');
    expect(parsed.agents.kai.agentHarness).toBe('anthropic_sdk');

    expect(() =>
      parseRuntimeSettings(`defaults:
  model: opus
  agent_engine: deepagents
`),
    ).toThrow('defaults.agent_engine is not supported');
    expect(() =>
      parseRuntimeSettings(`agents:
  kai:
    name: Kai
    agent_engine: deepagents
    model: gpt
`),
    ).toThrow('agents.kai.agent_engine is not supported');
  });

  it('rejects the retired memory.engine key', () => {
    expect(() =>
      parseRuntimeSettings(`memory:
  enabled: true
  engine: deepagents
  embeddings:
    enabled: false
    provider: disabled
`),
    ).toThrow('memory.engine is not supported');
  });

  it('validates memory model validity (no engine/family pairing rule)', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-memory-engine-ok-'),
    );
    try {
      const settings = createDefaultRuntimeSettings();
      // An OpenAI-family memory model is valid; the engine derives from it.
      settings.memory.llm.models.extractor = 'gpt';
      const result = validateLoadedRuntimeSettings(runtimeHome, settings);
      const details = result.failure?.details ?? [];
      expect(
        details.some((d) => d.startsWith('memory.llm.models.extractor')),
      ).toBe(false);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('mirrors persistent permission grants into readable semantic, Browser, and scoped RunCommand tools', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-tools-'),
    );
    try {
      const settings = createDefaultRuntimeSettings();
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        bindings: {},
        sources: emptySources(),
        capabilities: [
          { id: 'mcp__gantry__service_restart', version: 'builtin' },
        ],
      };
      saveRuntimeSettings(runtimeHome, settings);

      mirrorAgentToolRulesToRuntimeSettings({
        runtimeHome,
        agentFolder: 'main_agent',
        rules: [
          'RunCommand(npm test *)',
          'Browser',
          'capability:acme.records.append',
        ],
      });

      const parsed = loadRuntimeSettings(runtimeHome);
      expect(parsed.agents.main_agent.capabilities).toEqual([
        { id: 'mcp__gantry__service_restart', version: 'builtin' },
        { id: 'RunCommand(npm test *)', version: 'builtin' },
        { id: 'browser.use', version: 'builtin' },
        { id: 'acme.records.append', version: 'builtin' },
      ]);
      const yaml = fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8');
      expect(yaml).toContain('id: acme.records.append');
      expect(yaml).not.toContain('capabilityPolicy');
      expect(yaml).not.toContain('permission-rule:');
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects generated runtime skill paths before mirroring settings', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-generated-runtime-'),
    );
    try {
      const settings = createDefaultRuntimeSettings();
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        bindings: {},
        sources: emptySources(),
        capabilities: [],
      };
      saveRuntimeSettings(runtimeHome, settings);

      expect(() =>
        mirrorAgentToolRulesToRuntimeSettings({
          runtimeHome,
          agentFolder: 'main_agent',
          rules: [
            'RunCommand(/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
          ],
        }),
      ).toThrow(
        'Persistent RunCommand rules cannot reference generated runtime skill paths',
      );
      const parsed = loadRuntimeSettings(runtimeHome);
      expect(parsed.agents.main_agent.capabilities).toEqual([]);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects generated runtime skill paths in settings validation', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [
        {
          id: 'RunCommand(/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
          version: 'builtin',
        },
      ],
    };

    const result = validateLoadedRuntimeSettings(
      '/tmp/gantry-generated-runtime',
      settings,
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'Persistent RunCommand rules cannot reference generated runtime skill paths',
    );
  });

  it('rejects internal tool ids in settings agent tools', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [{ id: 'tool:permission-rule:abc123', version: 'builtin' }],
    };

    const result = validateLoadedRuntimeSettings('/tmp/gantry-tools', settings);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'agents.main_agent.capabilities contains invalid capability "tool:permission-rule:abc123"',
    );
  });

  it('rejects raw host-private browser MCP rules in settings agent tools', () => {
    for (const toolRule of [
      'mcp__browser' + '_' + 'backend' + '__*',
      'mcp__browser' + '_' + 'backend' + '__navigate',
      'mcp__browser' + '_' + 'backend' + '__navigate(url=https://example.com)',
      'mcp__browser' + '_' + 'backend' + '__click',
      'mcp__browser' + '_' + 'backend' + '__screenshot',
    ]) {
      const settings = createDefaultRuntimeSettings();
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        bindings: {},
        sources: emptySources(),
        capabilities: [{ id: toolRule, version: 'builtin' }],
      };

      const result = validateLoadedRuntimeSettings(
        '/tmp/gantry-tools',
        settings,
      );

      expect(result.ok).toBe(false);
      expect(result.failure?.details.join('\n')).toContain(
        `agents.main_agent.capabilities contains invalid capability "${toolRule}"`,
      );
      if (!toolRule.includes('(')) {
        expect(result.failure?.details.join('\n')).toContain(
          'use the canonical Browser tool capability instead',
        );
      }
    }
  });

  it('fails closed when mirroring persistent tools for a missing settings agent', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-tools-missing-'),
    );
    try {
      saveRuntimeSettings(runtimeHome, createDefaultRuntimeSettings());

      expect(() =>
        mirrorAgentToolRulesToRuntimeSettings({
          runtimeHome,
          agentFolder: 'missing_agent',
          rules: ['RunCommand(npm test *)'],
        }),
      ).toThrow('missing settings agent');
      const parsed = loadRuntimeSettings(runtimeHome);
      expect(parsed.agents.missing_agent).toBeUndefined();
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects raw host-private browser MCP rules before mirroring settings', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-tools-browser-'),
    );
    try {
      const settings = createDefaultRuntimeSettings();
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        bindings: {},
        sources: emptySources(),
        capabilities: [],
      };
      saveRuntimeSettings(runtimeHome, settings);

      expect(() =>
        mirrorAgentToolRulesToRuntimeSettings({
          runtimeHome,
          agentFolder: 'main_agent',
          rules: ['mcp__browser' + '_' + 'backend' + '__click'],
        }),
      ).toThrow('canonical Browser tool capability');
      const parsed = loadRuntimeSettings(runtimeHome);
      expect(parsed.agents.main_agent.capabilities).toEqual([]);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects projected browser MCP rules before mirroring settings', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-tools-browser-projected-'),
    );
    try {
      const settings = createDefaultRuntimeSettings();
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        bindings: {},
        sources: emptySources(),
        capabilities: [],
      };
      saveRuntimeSettings(runtimeHome, settings);

      expect(() =>
        mirrorAgentToolRulesToRuntimeSettings({
          runtimeHome,
          agentFolder: 'main_agent',
          rules: ['mcp__gantry__browser_act'],
        }),
      ).toThrow('runtime projections, not durable capabilities');
      const parsed = loadRuntimeSettings(runtimeHome);
      expect(parsed.agents.main_agent.capabilities).toEqual([]);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects non-exact Browser aliases before mirroring settings', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-tools-browser-alias-'),
    );
    try {
      const settings = createDefaultRuntimeSettings();
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        bindings: {},
        sources: emptySources(),
        capabilities: [],
      };
      saveRuntimeSettings(runtimeHome, settings);

      for (const rule of [
        'browser',
        'tool:Browser',
        'Browser(https://example.com/*)',
      ]) {
        expect(() =>
          mirrorAgentToolRulesToRuntimeSettings({
            runtimeHome,
            agentFolder: 'main_agent',
            rules: [rule],
          }),
        ).toThrow(/exact canonical Browser capability/);
      }
      const parsed = loadRuntimeSettings(runtimeHome);
      expect(parsed.agents.main_agent.capabilities).toEqual([]);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects malformed persistent tool rules before writing settings', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-tools-invalid-'),
    );
    try {
      const settings = createDefaultRuntimeSettings();
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        bindings: {},
        sources: emptySources(),
        capabilities: [],
      };
      saveRuntimeSettings(runtimeHome, settings);

      expect(() =>
        mirrorAgentToolRulesToRuntimeSettings({
          runtimeHome,
          agentFolder: 'main_agent',
          rules: ['mcp__gantry__service_restart(reason=test)'],
        }),
      ).toThrow('Only RunCommand supports persistent scoped tool rules');
      const parsed = loadRuntimeSettings(runtimeHome);
      expect(parsed.agents.main_agent.capabilities).toEqual([]);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects wildcard-scoped RunCommand rules before writing settings', () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-tools-bash-wildcard-'),
    );
    try {
      const settings = createDefaultRuntimeSettings();
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        bindings: {},
        sources: emptySources(),
        capabilities: [],
      };
      saveRuntimeSettings(runtimeHome, settings);

      expect(() =>
        mirrorAgentToolRulesToRuntimeSettings({
          runtimeHome,
          agentFolder: 'main_agent',
          rules: ['RunCommand(*)'],
        }),
      ).toThrow('Persistent RunCommand scope is too broad');
      const parsed = loadRuntimeSettings(runtimeHome);
      expect(parsed.agents.main_agent.capabilities).toEqual([]);
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects thread as a binding memory scope', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.agents.main_agent = {
      name: 'Main Agent',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.team = {
      providerConnection: 'telegram_default',
      externalId: '-100',
      kind: 'channel',
      displayName: 'Team',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['575'],
    };
    settings.bindings.main_team = {
      agent: 'main_agent',
      conversation: 'team',
      trigger: '@main',
      addedAt: '2026-05-04T00:00:00.000Z',
      requiresTrigger: false,
      memoryScope: 'thread' as never,
    };

    expect(() =>
      parseRuntimeSettings(renderRuntimeSettingsYaml(settings)),
    ).toThrow(/memory_scope must be conversation, user, or agent/);
  });

  it('keeps multi-binding conversations explicit without duplicating bindings', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.agents.main_agent = {
      name: 'Default Agent',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.agents.helper = {
      name: 'Helper',
      folder: 'helper',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.team = {
      providerConnection: 'telegram_default',
      externalId: '-100',
      kind: 'channel',
      displayName: 'Team',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['575'],
    };
    settings.conversations.solo = {
      providerConnection: 'telegram_default',
      externalId: '575',
      kind: 'dm',
      displayName: 'Solo',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['575'],
    };
    settings.bindings.main_team = {
      agent: 'main_agent',
      conversation: 'team',
      trigger: '@main',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: false,
      memoryScope: 'conversation',
    };
    settings.bindings.helper_team = {
      agent: 'helper',
      conversation: 'team',
      trigger: '@helper',
      addedAt: '2026-05-03T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
    };
    settings.bindings.main_solo = {
      agent: 'main_agent',
      conversation: 'solo',
      trigger: '@main',
      addedAt: '2026-05-04T00:00:00.000Z',
      requiresTrigger: false,
      memoryScope: 'conversation',
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    const parsed = parseRuntimeSettings(yaml);

    expect(
      Object.values(parsed.bindings).filter(
        (binding) => binding.conversation === 'team',
      ),
    ).toHaveLength(2);
    expect(
      Object.values(parsed.bindings).filter(
        (binding) => binding.conversation === 'solo',
      ),
    ).toHaveLength(1);
    expect(parsed.bindings.solo?.addedAt).toBe('2026-05-04T00:00:00.000Z');
  });

  it('renders non-default provider connection ids without rerouting', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.providerConnections.telegram_work = {
      provider: 'telegram',
      label: 'Telegram Work',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_WORK_BOT_TOKEN' },
    };
    settings.conversations.work = {
      providerConnection: 'telegram_work',
      externalId: '-200',
      kind: 'channel',
      displayName: 'Work',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
    };

    const parsed = parseRuntimeSettings(renderRuntimeSettingsYaml(settings));

    expect(parsed.conversations.work?.providerConnection).toBe('telegram_work');
  });

  it('rejects duplicate desired-state conversation bindings', () => {
    const yaml = `defaults:
  model: opus

agents:
  one:
    name: One
    bindings:
      primary:
        jid: tg:100
        trigger: '@one'
        added_at: 2026-05-02T00:00:00.000Z
  two:
    name: Two
    bindings:
      primary:
        jid: tg:100
        trigger: '@two'
        added_at: 2026-05-02T00:00:00.000Z
`;

    expect(() => parseRuntimeSettings(yaml)).toThrow(
      'agents.two.bindings contains duplicate jid tg:100; already configured by agents.one',
    );
  });

  it('rejects raw model ids in desired-state agent defaults', () => {
    const yaml = `defaults:
  model: opus

agents:
  main_agent:
    name: Main
    model: claude-opus-4-7
`;

    expect(() => parseRuntimeSettings(yaml)).toThrow(
      'agents.main_agent.model is invalid: Provider model ID "claude-opus-4-7" is not accepted here.',
    );
  });

  it('keeps generated conversation ids distinct when normalized ids collide', () => {
    const settings = createDefaultRuntimeSettings();

    const first = ensureConfiguredConversationBinding(settings, {
      agentId: 'main_agent',
      agentName: 'Main',
      agentFolder: 'main_agent',
      jid: 'tg:abc-def',
      displayName: 'First',
      trigger: '@main',
      requiresTrigger: true,
    });
    const second = ensureConfiguredConversationBinding(settings, {
      agentId: 'second_agent',
      agentName: 'Second',
      agentFolder: 'second_agent',
      jid: 'tg:abc:def',
      displayName: 'Second',
      trigger: '@second',
      requiresTrigger: true,
    });

    expect(first.conversationId).not.toEqual(second.conversationId);
    expect(
      Object.values(settings.conversations).map(
        (conversation) => conversation.externalId,
      ),
    ).toEqual(['abc-def', 'abc:def']);
    expect(Object.keys(settings.bindings)).toHaveLength(2);
  });

  it('seeds onboarding approvers into conversation policy only', () => {
    const settings = createDefaultRuntimeSettings();

    ensureConfiguredConversationBinding(settings, {
      agentId: 'main_agent',
      agentName: 'Default Agent',
      agentFolder: 'main_agent',
      jid: 'sl:C123',
      displayName: 'Engineering',
      trigger: '@Default Agent',
      requiresTrigger: true,
      approverIds: ['UADMIN', 'UHELPER'],
    });

    const conversation = Object.values(settings.conversations)[0];
    expect(conversation?.controlApprovers).toEqual(['UADMIN', 'UHELPER']);
    expect(conversation?.senderPolicy).toEqual({ allow: '*', mode: 'trigger' });
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).not.toContain('dm_access:');
    expect(yaml).toContain('    sender_policy:');
    expect(yaml).toContain('      mode: trigger');
    expect(yaml).toContain('    control_approvers: ["UADMIN","UHELPER"]');
  });

  it('maps compact DM conversation approvers to conversation policy', () => {
    const parsed = parseRuntimeSettings(`providers:
  telegram:
    enabled: true
    bot_token_ref: TELEGRAM_BOT_TOKEN

agents:
  main_agent:
    name: Main

conversations:
  main_dm:
    provider: telegram
    id: "5759865942"
    type: dm
    approvers: ["5759865942"]
    agent: main_agent
`);

    expect(parsed.conversations.main_dm.controlApprovers).toEqual([
      '5759865942',
    ]);
  });

  it('rejects agent dm_access because policy belongs to conversations', () => {
    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    dm_access:
      slack:
        allow: ["U123"]
`),
    ).toThrow('agents.main_agent.dm_access is not supported');
  });

  it('rejects conversation main because conversation policy has no privileged main flag', () => {
    expect(() =>
      parseRuntimeSettings(`providers:
  telegram:
    enabled: true
    bot_token_ref: TELEGRAM_BOT_TOKEN

agents:
  main_agent:
    name: Default Agent

conversations:
  team:
    provider: telegram
    id: "100"
    type: group
    agent: main_agent
    main: true
`),
    ).toThrow('conversations.team.main is not supported');
  });

  it('rejects binding main because bindings only carry trigger and conversation routing', () => {
    expect(() =>
      parseRuntimeSettings(`providers:
  telegram:
    enabled: true
    bot_token_ref: TELEGRAM_BOT_TOKEN

provider_connections:
  telegram_default:
    provider: telegram
    runtime_secret_refs:
      bot_token: TELEGRAM_BOT_TOKEN

agents:
  main_agent:
    name: Default Agent

conversations:
  team:
    provider_connection: telegram_default
    external_id: "100"
    kind: group

bindings:
  team:
    agent: main_agent
    conversation: team
    trigger: "@Default Agent"
    main: true
`),
    ).toThrow('bindings.team.main is not supported');
  });

  it('keeps same-agent Slack and Teams approvers conversation-scoped in settings', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
    bot_token_ref: SLACK_BOT_TOKEN
  teams:
    enabled: true
    client_id_ref: TEAMS_CLIENT_ID

agents:
  main_agent:
    name: Main

conversations:
  sales_slack:
    provider: slack
    id: "C123"
    type: channel
    approvers: ["U123"]
    agent: main_agent
  sales_teams:
    provider: teams
    id: "19:channel@thread.tacv2"
    type: channel
    approvers: ["8:orgid:abc"]
    agent: main_agent
`);

    expect(parsed.conversations.sales_slack.controlApprovers).toEqual(['U123']);
    expect(parsed.conversations.sales_teams.controlApprovers).toEqual([
      '8:orgid:abc',
    ]);
  });

  it('renders readable skill names beside exact durable skill ids', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.kai = {
      name: 'Kai',
      folder: 'kai',
      bindings: {},
      sources: {
        skills: [
          {
            name: 'linkedin-posting',
            id: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
          },
          { id: 'company-handbook' },
        ],
        mcpServers: [],
        tools: [],
      },
      capabilities: [],
    };

    const yaml = renderRuntimeSettingsYaml(settings);

    expect(yaml).toContain(
      [
        '        skills:',
        '          - name: linkedin-posting',
        '            id: "skill:3014949c-a616-4b2c-80e7-0bc61bb31e85"',
      ].join('\n'),
    );
    expect(yaml).toContain('company-handbook');
    expect(parseRuntimeSettings(yaml).agents.kai.sources.skills).toEqual([
      {
        name: 'linkedin-posting',
        id: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
      },
      { id: 'company-handbook' },
    ]);
  });
});

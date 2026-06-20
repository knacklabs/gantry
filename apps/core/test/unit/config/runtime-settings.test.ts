import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createDefaultRuntimeSettings,
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  mirrorAgentToolRulesToRuntimeSettings,
  parseRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { validateLoadedRuntimeSettings } from '@core/config/settings/runtime-settings-validation.js';
import { settingsFilePath } from '@core/config/settings/runtime-home.js';
import { runSettingsCommand } from '@core/cli/settings.js';

function emptySources() {
  return { skills: [], mcpServers: [], tools: [] };
}

describe('runtime settings', () => {
  it('defaults, renders, and parses agent.name', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.agent.name).toBe('Default Agent');

    settings.agent.name = 'Kai';
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('name: Kai');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agent.name).toBe('Kai');
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

  it('parses configured MCP server desired state for fresh database reconcile', () => {
    const parsed = parseRuntimeSettings(`
desired_state:
  authoritative: true

mcp_servers:
  "mcp:shopify-api":
    name: shopify-api
    transport: http
    url: http://127.0.0.1:8081/mcp
    caller_identity:
      mode: required
      header_name: X-Caller-Identity
      signing_ref: MCP_IDENTITY_SECRET
      source:
        kind: conversation_jid_phone
        jid_prefix: "wa:"
    risk_class: medium
    allowed_tool_patterns: ["lookup_*"]
    auto_approve_tool_patterns: ["lookup_*"]
    credential_refs: [{"name":"SHOPIFY_DEV_SHOP_DOMAIN","target":"env","key":"SHOPIFY_DEV_SHOP_DOMAIN"}]

agents:
  boondi_support:
    name: Boondi
    sources:
      mcp_servers:
        - id: "mcp:shopify-api"
`);

    expect(parsed.mcpServers['mcp:shopify-api']).toMatchObject({
      name: 'shopify-api',
      riskClass: 'medium',
      config: {
        transport: 'http',
        url: 'http://127.0.0.1:8081/mcp',
        callerIdentity: {
          headerName: 'X-Caller-Identity',
          signingRef: 'MCP_IDENTITY_SECRET',
          source: { jidPrefix: 'wa:' },
        },
      },
      allowedToolPatterns: ['lookup_*'],
      autoApproveToolPatterns: ['lookup_*'],
      credentialRefs: [
        {
          name: 'SHOPIFY_DEV_SHOP_DOMAIN',
          target: 'env',
          key: 'SHOPIFY_DEV_SHOP_DOMAIN',
        },
      ],
    });
    expect(parsed.agents.boondi_support.sources.mcpServers).toEqual([
      { id: 'mcp:shopify-api' },
    ]);
    expect(renderRuntimeSettingsYaml(parsed)).toContain('mcp_servers:');
  });

  it('parses an http MCP connector with no credential_refs to an empty list', () => {
    const parsed = parseRuntimeSettings(`
mcp_servers:
  "mcp:boondi-crm":
    name: boondi-crm
    transport: http
    url: http://127.0.0.1:8082/mcp
    caller_identity:
      mode: required
      header_name: X-Caller-Identity
      signing_ref: MCP_IDENTITY_SECRET
      source:
        kind: conversation_jid_phone
        jid_prefix: "wa:"
    risk_class: medium
    allowed_tool_patterns: ["record_*"]
    auto_approve_tool_patterns: ["record_*"]
`);

    expect(parsed.mcpServers['mcp:boondi-crm']).toMatchObject({
      name: 'boondi-crm',
      config: { transport: 'http', url: 'http://127.0.0.1:8082/mcp' },
      credentialRefs: [],
    });
    // Cleanup safety: the connector still round-trips through the renderer.
    expect(renderRuntimeSettingsYaml(parsed)).toContain('mcp:boondi-crm');
  });

  it('renders and parses the configured agent guardrail plugin (file + model)', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.boondi_support = {
      name: 'Boondi',
      folder: 'boondi_support',
      plugins: {
        guardrail: { file: 'guardrail.ts', model: 'haiku' },
      },
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('plugins:');
    expect(yaml).toContain('guardrail:');
    expect(yaml).toContain('file: guardrail.ts');
    expect(yaml).toContain('model: haiku');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.agents.boondi_support.plugins?.guardrail).toEqual({
      file: 'guardrail.ts',
      model: 'haiku',
      mode: 'both',
      unresolved: 'classifier',
    });
  });

  it('parses the configured agent guardrail plugin from YAML', () => {
    const parsed = parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    plugins:
      guardrail:
        file: guardrail.ts
        model: haiku
`);

    expect(parsed.agents.boondi_support?.plugins?.guardrail).toEqual({
      file: 'guardrail.ts',
      model: 'haiku',
      mode: 'both',
      unresolved: 'classifier',
    });
  });

  it('rejects raw provider model ids for configured agent guardrails', () => {
    expect(() =>
      parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    plugins:
      guardrail:
        file: guardrail.ts
        model: claude-haiku-4-5-20251001
`),
    ).toThrow(
      'agents.boondi_support.plugins.guardrail.model is invalid: Provider model ID "claude-haiku-4-5-20251001" is not accepted here. Use a model alias from /models.',
    );
  });

  it('defaults, renders, and parses runtime queue policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.runtime.queue).toEqual({
      maxMessageRuns: 3,
      maxJobRuns: 4,
      maxRetries: 5,
      baseRetryMs: 5000,
    });

    settings.runtime.queue = {
      maxMessageRuns: 6,
      maxJobRuns: 2,
      maxRetries: 1,
      baseRetryMs: 250,
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('runtime:');
    expect(yaml).toContain('max_message_runs: 6');
    expect(yaml).toContain('max_job_runs: 2');
    expect(yaml).toContain('max_retries: 1');
    expect(yaml).toContain('base_retry_ms: 250');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.queue).toEqual(settings.runtime.queue);
  });

  it('defaults, renders, and parses runtime warm pool policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.runtime.warmPool).toEqual({
      enabled: false,
      size: 1,
      idleTtlMs: 240_000,
      maxBoundWorkers: 100,
      cachePrewarmEnabled: false,
      cachePrewarmConcurrency: 1,
    });

    settings.runtime.warmPool = {
      enabled: true,
      size: 2,
      idleTtlMs: 120_000,
      maxBoundWorkers: 10,
      cachePrewarmEnabled: true,
      cachePrewarmConcurrency: 2,
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('runtime:');
    expect(yaml).toContain('warm_pool:');
    expect(yaml).toContain('enabled: true');
    expect(yaml).toContain('size: 2');
    expect(yaml).toContain('idle_ttl_ms: 120000');
    expect(yaml).toContain('max_bound_workers: 10');
    expect(yaml).toContain('cache_prewarm_enabled: true');
    expect(yaml).toContain('cache_prewarm_concurrency: 2');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.warmPool).toEqual(settings.runtime.warmPool);
  });

  it('defaults, renders, and parses runtime runner policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.runtime.runner).toEqual({
      idleTimeoutMs: 1_800_000,
    });

    settings.runtime.runner = {
      idleTimeoutMs: 2_500,
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('runtime:');
    expect(yaml).toContain('runner:');
    expect(yaml).toContain('idle_timeout_ms: 2500');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.runner).toEqual(settings.runtime.runner);
  });

  it('defaults, renders, and parses runtime ownership policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.runtime.ownership).toEqual({
      leaseTtlMs: 45_000,
      heartbeatIntervalMs: 15_000,
      reconcilerIntervalMs: 15_000,
      reconcilerLimit: 100,
      shutdownClaimWaitMs: 1_000,
    });

    settings.runtime.ownership = {
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      reconcilerIntervalMs: 2_500,
      reconcilerLimit: 50,
      shutdownClaimWaitMs: 250,
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('runtime:');
    expect(yaml).toContain('ownership:');
    expect(yaml).toContain('lease_ttl_ms: 30000');
    expect(yaml).toContain('heartbeat_interval_ms: 10000');
    expect(yaml).toContain('reconciler_interval_ms: 2500');
    expect(yaml).toContain('reconciler_limit: 50');
    expect(yaml).toContain('shutdown_claim_wait_ms: 250');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.ownership).toEqual(settings.runtime.ownership);
  });

  it('defaults, renders, and parses runtime trace payload retention policy', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.runtime.trace).toEqual({
      payloadRetentionMs: 86_400_000,
      payloadCleanupIntervalMs: 3_600_000,
    });

    settings.runtime.trace = {
      payloadRetentionMs: 7_200_000,
      payloadCleanupIntervalMs: 60_000,
    };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('runtime:');
    expect(yaml).toContain('trace:');
    expect(yaml).toContain('payload_retention_ms: 7200000');
    expect(yaml).toContain('payload_cleanup_interval_ms: 60000');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.trace).toEqual(settings.runtime.trace);
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

  it('rejects unsupported runtime warm pool keys', () => {
    expect(() =>
      parseRuntimeSettings(`runtime:
  warm_pool:
    enabled: true
    warmed_workers: 2
`),
    ).toThrow(
      'runtime.warm_pool.warmed_workers is not supported. Configure enabled, size, idle_ttl_ms, max_bound_workers, cache_prewarm_enabled, or cache_prewarm_concurrency.',
    );
  });

  it('rejects unsupported runtime runner keys', () => {
    expect(() =>
      parseRuntimeSettings(`runtime:
  runner:
    idle_timeout: 2500
`),
    ).toThrow(
      'runtime.runner.idle_timeout is not supported. Configure idle_timeout_ms.',
    );
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

  const memoryYaml = (extra = '') => `memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
    daily_limit: 500
    batch_size: 16
  dreaming:
    enabled: false
    cron: "15 3 * * *"
    embeddings:
      enabled: false
      provider: disabled
      model: text-embedding-3-large
  llm:
    extractor_max_facts: 8
    extractor_min_confidence: 0.6
    models:
      extractor: haiku
      dreaming: sonnet
      consolidation: sonnet
  maintenance:
    max_pending: 5000
${extra}`;

  it('parses idle sweep concurrency and extraction timeout', () => {
    const parsed = parseRuntimeSettings(
      memoryYaml(
        '  idle_sweep_concurrency: 5\n  idle_sweep_extraction_timeout_ms: 60000\n',
      ),
    );
    expect(parsed.memory.idleSweepConcurrency).toBe(5);
    expect(parsed.memory.idleSweepExtractionTimeoutMs).toBe(60000);
  });

  it('defaults idle sweep concurrency to 3 and extraction timeout to 45000', () => {
    const parsed = parseRuntimeSettings(memoryYaml());
    expect(parsed.memory.idleSweepConcurrency).toBe(3);
    expect(parsed.memory.idleSweepExtractionTimeoutMs).toBe(45000);
  });

  it('rejects a non-positive idle_sweep_concurrency', () => {
    expect(() =>
      parseRuntimeSettings(memoryYaml('  idle_sweep_concurrency: 0\n')),
    ).toThrow(/idle_sweep_concurrency/);
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

  it('keeps explicit verbose provider connections over compact defaults', () => {
    const parsed = parseRuntimeSettings(`providers:
  telegram:
    enabled: true
    label: Compact Telegram
    bot_token_env: TELEGRAM_COMPACT_BOT_TOKEN

provider_connections:
  telegram_default:
    provider: telegram
    label: Explicit Telegram
    runtime_secret_refs:
      bot_token: TELEGRAM_EXPLICIT_BOT_TOKEN
`);

    expect(parsed.providerConnections.telegram_default).toMatchObject({
      label: 'Explicit Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_EXPLICIT_BOT_TOKEN' },
    });
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
    bot_token_env: SLACK_BOT_TOKEN

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

  it('renders and parses local desired-state agents', () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Default Agent',
      folder: 'main_agent',
      persona: 'generalist',
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
    expect(renderRuntimeSettingsYaml(parsed)).toContain(
      '    persona: generalist',
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
    bot_token_env: TELEGRAM_BOT_TOKEN

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
    bot_token_env: TELEGRAM_BOT_TOKEN

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
    bot_token_env: TELEGRAM_BOT_TOKEN

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
    bot_token_env: SLACK_BOT_TOKEN
  teams:
    enabled: true
    client_id_env: TEAMS_CLIENT_ID

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
        '      skills:',
        '        - name: linkedin-posting',
        '          id: "skill:3014949c-a616-4b2c-80e7-0bc61bb31e85"',
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

  describe('Interakt default_agent and template flag', () => {
    // Setting bot_token_env triggers compactProviderToVerbose to register an
    // interakt_default provider_connection, which conversations.provider:
    // interakt references implicitly.
    const baseYaml = (extras: string) => `desired_state:
  authoritative: true

agents:
  boondi_support:
    name: Boondi
    persona: sales

providers:
  interakt:
    enabled: true
    bot_token_env: INTERAKT_BOT_TOKEN
${extras}`;

    it('parses providers.interakt.default_agent when the agent folder exists', () => {
      const parsed = parseRuntimeSettings(
        baseYaml('    default_agent: boondi_support'),
      );
      expect(parsed.providers.interakt.defaultAgent).toBe('boondi_support');
    });

    it('throws when providers.interakt.default_agent references an unknown agent folder', () => {
      expect(() =>
        parseRuntimeSettings(baseYaml('    default_agent: nope_agent')),
      ).toThrow(
        /providers\.interakt\.default_agent references unknown agent folder "nope_agent"/,
      );
    });

    it('parses conversations.<id>.template: true via interakt provider', () => {
      const yaml = `${baseYaml('')}
conversations:
  boondi_template:
    provider: interakt
    id: "wa:template"
    type: dm
    display_name: Boondi
    template: true
    agent: boondi_support
    trigger: "@Boondi"
    requires_trigger: false
`;
      const parsed = parseRuntimeSettings(yaml);
      expect(parsed.conversations.boondi_template.isTemplate).toBe(true);
    });

    it('rejects template values that are not booleans', () => {
      const yaml = `${baseYaml('')}
conversations:
  boondi_template:
    provider: interakt
    id: "wa:template"
    type: dm
    display_name: Boondi
    template: "yes"
    agent: boondi_support
    trigger: "@Boondi"
`;
      expect(() => parseRuntimeSettings(yaml)).toThrow(
        /conversations\.boondi_template\.template must be true\/false/,
      );
    });

    it('round-trips default_agent and template through YAML', () => {
      const yaml = `${baseYaml('    default_agent: boondi_support')}
conversations:
  boondi_template:
    provider: interakt
    id: "wa:template"
    type: dm
    display_name: Boondi
    template: true
    agent: boondi_support
    trigger: "@Boondi"
    requires_trigger: false
`;
      const parsed = parseRuntimeSettings(yaml);
      const rendered = renderRuntimeSettingsYaml(parsed);
      expect(rendered).toContain('default_agent: boondi_support');
      expect(rendered).toContain('template: true');
      const reparsed = parseRuntimeSettings(rendered);
      expect(reparsed.providers.interakt.defaultAgent).toBe('boondi_support');
      expect(reparsed.conversations.boondi_template.isTemplate).toBe(true);
    });
  });
});

describe('agents tool_surface', () => {
  it('parses and renders a customer_live prompt surface', () => {
    const parsed = parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    prompt_surface: customer_live
`);
    expect(parsed.agents.boondi_support.promptSurface).toBe('customer_live');

    const rendered = renderRuntimeSettingsYaml(parsed);
    expect(rendered).toContain('prompt_surface: customer_live');

    const reparsed = parseRuntimeSettings(rendered);
    expect(reparsed.agents.boondi_support.promptSurface).toBe('customer_live');
  });

  it('rejects unknown prompt surfaces', () => {
    expect(() =>
      parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    prompt_surface: internal_debug
`),
    ).toThrow(
      'agents.boondi_support.prompt_surface must be one of: full, customer_live',
    );
  });

  it('parses a gantry MCP keep-list and renders it back', () => {
    const parsed = parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    tool_surface:
      gantry_mcp: [mcp_call_tool, mcp_list_tools, memory_search, memory_save]
`);
    expect(parsed.agents.boondi_support.toolSurface).toEqual({
      gantryMcp: [
        'mcp_call_tool',
        'mcp_list_tools',
        'memory_save',
        'memory_search',
      ],
    });
    const rendered = renderRuntimeSettingsYaml(parsed);
    expect(rendered).toContain('tool_surface:');
    expect(rendered).toContain(
      'gantry_mcp: ["mcp_call_tool","mcp_list_tools","memory_save","memory_search"]',
    );
    const reparsed = parseRuntimeSettings(rendered);
    expect(reparsed.agents.boondi_support.toolSurface).toEqual(
      parsed.agents.boondi_support.toolSurface,
    );
  });

  it('rejects unknown gantry MCP tool names', () => {
    expect(() =>
      parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    tool_surface:
      gantry_mcp: [mcp_call_tool, not_a_real_tool]
`),
    ).toThrow(
      'agents.boondi_support.tool_surface.gantry_mcp[1] "not_a_real_tool" is not a known gantry MCP tool name.',
    );
  });

  it('rejects admin tools in the keep-list with a pointer to capabilities', () => {
    expect(() =>
      parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    tool_surface:
      gantry_mcp: [service_restart]
`),
    ).toThrow(
      'agents.boondi_support.tool_surface.gantry_mcp[0] "service_restart" is a Gantry admin tool; grant it via capabilities, not tool_surface.',
    );
  });

  it('rejects unsupported tool_surface keys', () => {
    expect(() =>
      parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    tool_surface:
      coding_tools: [Bash]
`),
    ).toThrow(
      'agents.boondi_support.tool_surface.coding_tools is not supported',
    );
  });
});

describe('agents tool_surface.native', () => {
  it('parses a native keep-list and renders it back', () => {
    const parsed = parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    tool_surface:
      gantry_mcp: [mcp_call_tool]
      native: [Skill, ToolSearch]
`);
    expect(parsed.agents.boondi_support.toolSurface).toEqual({
      gantryMcp: ['mcp_call_tool'],
      native: ['Skill', 'ToolSearch'],
    });
    const rendered = renderRuntimeSettingsYaml(parsed);
    expect(rendered).toContain('native: ["Skill","ToolSearch"]');
    const reparsed = parseRuntimeSettings(rendered);
    expect(reparsed.agents.boondi_support.toolSurface).toEqual(
      parsed.agents.boondi_support.toolSurface,
    );
  });

  it('rejects unknown native SDK tool names', () => {
    expect(() =>
      parseRuntimeSettings(`
agents:
  boondi_support:
    name: Boondi
    tool_surface:
      native: [Skill, NotARealTool]
`),
    ).toThrow(
      'agents.boondi_support.tool_surface.native[1] "NotARealTool" is not a known native SDK tool name.',
    );
  });
});

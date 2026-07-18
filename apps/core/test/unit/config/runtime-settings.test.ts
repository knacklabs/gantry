import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createDefaultRuntimeSettings,
  ensureConfiguredAgent,
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
import {
  deriveBindingsFromConversationInstalls,
  flattenConversationInstalls,
} from '@core/config/settings/runtime-settings-binding-derivation.js';
import type { RuntimeConfiguredConversation } from '@core/config/settings/runtime-settings-types.js';
import {
  parseSimpleYamlObject,
  quoteYamlString,
} from '@core/config/settings/yaml.js';

function emptySources() {
  return { skills: [], mcpServers: [], tools: [] };
}

describe('runtime settings', () => {
  it('adds active MCP source refs before desired-state mirroring reconciles settings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'ReAgent',
      folder: 'main_agent',
      delegates: [],
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

  it('rejects stale provider connection and binding settings keys', () => {
    for (const yaml of [
      'provider_' + 'connections: {}',
      'bindings: {}',
      'providers:\n  slack:\n    enabled: true\n    default_connection: slack_default\n',
      'agents:\n  main_agent:\n    name: Main\n    bindings: {}\n',
      'agents:\n  main_agent:\n    name: Main\n    requires_trigger: true\n',
      'conversations:\n  c1:\n    provider_connection: slack_one\n',
    ]) {
      expect(() => parseRuntimeSettings(yaml)).toThrow(
        /not supported|no longer supported/,
      );
    }
  });

  it('accepts two provider accounts installed in one conversation', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
  agent_two:
    name: Two
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
    runtime_secret_refs:
      bot_token: gantry-secret:SLACK_ONE_BOT_TOKEN
    config:
      signing_secret_ref: gantry-secret:SLACK_ONE_SIGNING_SECRET
    external_identity_ref:
      team_id: T1
      bot_user_id: U1
  slack_two:
    agent: agent_two
    provider: slack
    label: Two Slack Bot
    runtime_secret_refs:
      bot_token: gantry-secret:SLACK_TWO_BOT_TOKEN
    external_identity_ref:
      team_id: T1
      bot_user_id: U2
conversations:
  shared_channel:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    control_approvers: ["slack:UADMIN"]
    installed_agents:
      agent_one:
        provider_account: slack_one
      agent_two:
        provider_account: slack_two
        added_at: 2026-05-02T00:00:00.000Z
        permission_mode: auto_strict
`);

    expect(Object.keys(parsed.providerAccounts)).toEqual([
      'slack_one',
      'slack_two',
    ]);
    expect(
      Object.values(parsed.conversations.shared_channel.installedAgents).map(
        (install) => install.providerAccountId,
      ),
    ).toEqual(['slack_one', 'slack_two']);
    expect(renderRuntimeSettingsYaml(parsed)).toContain('provider_accounts:');
    expect(renderRuntimeSettingsYaml(parsed)).toContain('installed_agents:');
    expect(renderRuntimeSettingsYaml(parsed)).toContain(
      'added_at: "2026-05-02T00:00:00.000Z"',
    );
    expect(
      parseRuntimeSettings(renderRuntimeSettingsYaml(parsed)).conversations
        .shared_channel.installedAgents.agent_two.addedAt,
    ).toBe('2026-05-02T00:00:00.000Z');
    expect(
      parseRuntimeSettings(renderRuntimeSettingsYaml(parsed)).conversations
        .shared_channel.installedAgents.agent_two.permissionMode,
    ).toBe('auto_strict');
    expect(() =>
      parseRuntimeSettings(
        renderRuntimeSettingsYaml(parsed).replace(
          'permission_mode: auto_strict',
          'permission_mode: always',
        ),
      ),
    ).toThrow(
      'conversations.shared_channel.installed_agents.agent_two.permission_mode must be one of ask, auto, or auto_strict',
    );
    expect(renderRuntimeSettingsYaml(parsed)).toContain(
      'signing_secret_ref: "gantry-secret:SLACK_ONE_SIGNING_SECRET"',
    );
  });

  it('accepts provider-account-only conversation objects', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.agents.agent_one = {
      name: 'One',
      folder: 'agent_one',
      delegates: [],
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.providerAccounts.slack_one = {
      agentId: 'agent_one',
      provider: 'slack',
      label: 'One Slack Bot',
      runtimeSecretRefs: {},
    };
    const conversation = {
      providerAccount: 'slack_one',
      externalId: 'slack:C123',
      kind: 'channel',
      displayName: 'shared',
      brainHarvest: false,
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['slack:UADMIN'],
      installedAgents: {},
    } satisfies RuntimeConfiguredConversation;
    settings.conversations.shared_channel = conversation;

    const rendered = renderRuntimeSettingsYaml(settings);
    expect(rendered).toContain('provider_account: slack_one');
    expect(rendered).not.toContain('providerConnection');
    expect(parseRuntimeSettings(rendered).conversations.shared_channel).toEqual(
      expect.objectContaining({ providerAccount: 'slack_one' }),
    );
  });

  it('round-trips per-conversation brain harvest with default off', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
conversations:
  opted_in:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    brain_harvest: true
  default_off:
    provider_account: slack_one
    id: slack:C999
    type: channel
    display_name: quiet
`);

    expect(parsed.conversations.opted_in.brainHarvest).toBe(true);
    expect(parsed.conversations.default_off.brainHarvest).toBe(false);
    const rendered = renderRuntimeSettingsYaml(parsed);
    expect(rendered).toContain('brain_harvest: true');
    expect(rendered).not.toContain('brain_harvest: false');
    expect(
      parseRuntimeSettings(rendered).conversations.opted_in.brainHarvest,
    ).toBe(true);
    expect(
      parseRuntimeSettings(rendered).conversations.default_off.brainHarvest,
    ).toBe(false);
  });

  it('preserves thread-scoped conversation installs in derived bindings', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
conversations:
  shared_channel:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    installed_agents:
      agent_one:
        provider_account: slack_one
        thread_id: "171.222"
`);

    expect(parsed.bindings['agent_one_shared_channel_171.222']?.threadId).toBe(
      '171.222',
    );
    expect(
      parsed.agents.agent_one.bindings['agent_one_shared_channel_171.222'],
    ).toEqual(
      expect.objectContaining({
        jid: 'sl:slack:C123',
        threadId: '171.222',
        providerAccountId: 'slack_one',
      }),
    );
    expect(
      parsed.conversationInstalls['agent_one_shared_channel_171.222']?.threadId,
    ).toBe('171.222');
  });

  it('keeps same-agent thread installs distinct in derived binding ids', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
conversations:
  shared_channel:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    installed_agents: {}
`);

    parsed.conversations.shared_channel.installedAgents = {
      first: {
        agentId: 'agent_one',
        providerAccountId: 'slack_one',
        threadId: '171.111',
        status: 'active',
        addedAt: new Date(0).toISOString(),
        memoryScope: 'conversation',
      },
      second: {
        agentId: 'agent_one',
        providerAccountId: 'slack_one',
        threadId: '171.222',
        status: 'active',
        addedAt: new Date(0).toISOString(),
        memoryScope: 'conversation',
      },
    };

    expect(
      Object.keys(deriveBindingsFromConversationInstalls(parsed.conversations)),
    ).toEqual([
      'agent_one_shared_channel_171.111',
      'agent_one_shared_channel_171.222',
    ]);
    expect(
      Object.keys(flattenConversationInstalls(parsed.conversations)),
    ).toEqual([
      'agent_one_shared_channel_171.111',
      'agent_one_shared_channel_171.222',
    ]);
  });

  it('keeps disabled conversation installs out of runtime bindings', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
conversations:
  shared_channel:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    installed_agents:
      agent_one:
        provider_account: slack_one
        status: disabled
        trigger: "@one"
`);

    expect(
      parsed.conversations.shared_channel.installedAgents.agent_one.status,
    ).toBe('disabled');
    expect(parsed.bindings).toEqual({});
    expect(parsed.agents.agent_one.bindings).toEqual({});
    expect(renderRuntimeSettingsYaml(parsed)).toContain('status: disabled');
  });

  it('accepts app memory scope on conversation installs', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
conversations:
  shared_channel:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    installed_agents:
      agent_one:
        provider_account: slack_one
        memory_scope: app
`);

    expect(
      parsed.conversations.shared_channel.installedAgents.agent_one.memoryScope,
    ).toBe('app');
  });

  it('defaults channel installs to trigger-required and direct installs to open', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
conversations:
  shared_channel:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    installed_agents:
      agent_one:
        provider_account: slack_one
  direct_chat:
    provider_account: slack_one
    id: slack:D123
    type: direct
    display_name: direct
    installed_agents:
      agent_one:
        provider_account: slack_one
  dm_chat:
    provider_account: slack_one
    id: slack:D456
    type: dm
    display_name: dm
    installed_agents:
      agent_one:
        provider_account: slack_one
`);

    expect(
      parsed.conversations.shared_channel.installedAgents.agent_one
        .requiresTrigger,
    ).toBe(true);
    expect(
      parsed.conversations.direct_chat.installedAgents.agent_one
        .requiresTrigger,
    ).toBe(false);
    expect(
      parsed.conversations.dm_chat.installedAgents.agent_one.requiresTrigger,
    ).toBe(false);
  });

  it('omits undefined requires_trigger when rendering conversation installs', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
conversations:
  shared_channel:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    installed_agents:
      agent_one:
        provider_account: slack_one
`);

    delete parsed.conversations.shared_channel.installedAgents.agent_one
      .requiresTrigger;

    const rendered = renderRuntimeSettingsYaml(parsed);

    expect(rendered).not.toContain('requires_trigger: undefined');
    expect(
      parseRuntimeSettings(rendered).conversations.shared_channel,
    ).toMatchObject({
      installedAgents: {
        agent_one: {
          requiresTrigger: true,
        },
      },
    });
  });

  it('preserves explicit false requires_trigger on channel installs', () => {
    const parsed = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
conversations:
  shared_channel:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: shared
    installed_agents:
      agent_one:
        provider_account: slack_one
        requires_trigger: false
`);

    expect(
      parsed.conversations.shared_channel.installedAgents.agent_one
        .requiresTrigger,
    ).toBe(false);
    expect(renderRuntimeSettingsYaml(parsed)).toContain(
      'requires_trigger: false',
    );
  });

  it('rejects duplicate provider account native identity evidence', () => {
    expect(() =>
      parseRuntimeSettings(`agents:
  agent_one:
    name: One
  agent_two:
    name: Two
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
    external_identity_ref:
      team_id: T1
      bot_user_id: U1
  slack_two:
    agent: agent_two
    provider: slack
    label: Two Slack Bot
    external_identity_ref:
      team_id: T1
      bot_user_id: U1
`),
    ).toThrow('external_identity_ref duplicates another provider account');
  });

  it('allows active provider account identity evidence reused from disabled accounts', () => {
    const parsed = parseRuntimeSettings(`agents:
  agent_one:
    name: One
  agent_two:
    name: Two
provider_accounts:
  slack_old:
    agent: agent_one
    provider: slack
    label: Old Slack Bot
    status: disabled
    external_identity_ref:
      team_id: T1
      bot_user_id: U1
  slack_new:
    agent: agent_two
    provider: slack
    label: New Slack Bot
    external_identity_ref:
      team_id: T1
      bot_user_id: U1
`);

    expect(parsed.providerAccounts.slack_old.status).toBe('disabled');
    expect(parsed.providerAccounts.slack_new.status).toBeUndefined();
  });

  it('does not persist empty provider account native identity evidence', () => {
    const parsed = parseRuntimeSettings(`agents:
  agent_one:
    name: One
provider_accounts:
  slack_one:
    agent: agent_one
    provider: slack
    label: One Slack Bot
`);

    expect(
      parsed.providerAccounts.slack_one.externalIdentityRef,
    ).toBeUndefined();
    expect(renderRuntimeSettingsYaml(parsed)).not.toContain(
      'external_identity_ref',
    );
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
      delegates: [],
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

  it('defaults, renders, and parses per-agent delegates', () => {
    const settings = createDefaultRuntimeSettings();
    ensureConfiguredAgent(settings, {
      agentId: 'main_agent',
      agentName: 'Main',
    });
    expect(settings.agents.main_agent.delegates).toEqual([]);
    expect(renderRuntimeSettingsYaml(settings)).not.toContain('delegates:');

    settings.agents.main_agent.delegates = ['researcher', 'future_agent'];
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain(
      '    delegates:\n      - researcher\n      - future_agent',
    );
    expect(parseRuntimeSettings(yaml).agents.main_agent.delegates).toEqual([
      'researcher',
      'future_agent',
    ]);
    expect(
      parseRuntimeSettings('agents:\n  main_agent:\n    name: Main\n').agents
        .main_agent.delegates,
    ).toEqual([]);
  });

  it('rejects non-string per-agent delegates', () => {
    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    delegates:
      - researcher
      - 42
`),
    ).toThrow('agents.main_agent.delegates[1] must be a non-empty string');
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

  it('keeps decimal-looking scalars as strings (thread timestamps, versions)', () => {
    expect(
      parseSimpleYamlObject(`decimal: 0.5
integer: 1
thread_ts: 171.222
version: 1.2.3
quoted_decimal: "0.5"
`),
    ).toEqual({
      decimal: '0.5',
      integer: 1,
      thread_ts: '171.222',
      version: '1.2.3',
      quoted_decimal: '0.5',
    });
    expect(quoteYamlString('171.222')).toBe('171.222');
    expect(quoteYamlString('1.2.3')).toBe('1.2.3');
  });

  it('defaults observability tracing and omits the default block', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.observability).toEqual({
      tracing: {
        enabled: false,
        endpoint: '',
        captureContent: true,
        sampleRate: 1,
      },
    });

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).not.toContain('observability:');
    expect(parseRuntimeSettings(yaml).observability).toEqual(
      settings.observability,
    );
  });

  it('accepts the complete observability tracing block', () => {
    const parsed = parseRuntimeSettings(`observability:
  tracing:
    enabled: true
    endpoint: https://telemetry.example.test/v1/traces
    capture_content: false
    sample_rate: 0.25
    environment: staging
`);

    expect(parsed.observability).toEqual({
      tracing: {
        enabled: true,
        endpoint: 'https://telemetry.example.test/v1/traces',
        captureContent: false,
        sampleRate: 0.25,
        environment: 'staging',
      },
    });
  });

  it('accepts observability sample rate boundaries', () => {
    for (const sampleRate of [0, 1]) {
      const parsed = parseRuntimeSettings(`observability:
  tracing:
    sample_rate: ${sampleRate}
`);
      expect(parsed.observability.tracing.sampleRate).toBe(sampleRate);
    }
  });

  it('rejects unknown observability keys', () => {
    expect(() =>
      parseRuntimeSettings(`observability:
  metrics: {}
`),
    ).toThrow(/observability\.metrics is not supported/);
    expect(() =>
      parseRuntimeSettings(`observability:
  tracing:
    exporter: custom
`),
    ).toThrow(/observability\.tracing\.exporter is not supported/);
  });

  it('rejects observability mapping and leaf type errors', () => {
    for (const [yaml, error] of [
      ['observability: true\n', /observability must be a mapping/],
      [
        'observability:\n  tracing: true\n',
        /observability\.tracing must be a mapping/,
      ],
      [
        'observability:\n  tracing:\n    enabled: "true"\n',
        /observability\.tracing\.enabled must be true\/false/,
      ],
      [
        'observability:\n  tracing:\n    endpoint: 123\n',
        /observability\.tracing\.endpoint must be a string/,
      ],
      [
        'observability:\n  tracing:\n    capture_content: "false"\n',
        /observability\.tracing\.capture_content must be true\/false/,
      ],
      [
        'observability:\n  tracing:\n    environment: 123\n',
        /observability\.tracing\.environment must be a string/,
      ],
    ] as const) {
      expect(() => parseRuntimeSettings(yaml)).toThrow(error);
    }
  });

  it('rejects invalid observability sample rates', () => {
    for (const sampleRate of ['fast', '[]', '-0.1', '1.1']) {
      expect(() =>
        parseRuntimeSettings(`observability:
  tracing:
    sample_rate: ${sampleRate}
`),
      ).toThrow(
        /observability\.tracing\.sample_rate must be a number between 0 and 1/,
      );
    }
  });

  it('round-trips non-default observability with empty optional strings', () => {
    const settings = createDefaultRuntimeSettings();
    settings.observability.tracing.captureContent = false;
    settings.observability.tracing.sampleRate = 0.25;
    settings.observability.tracing.environment = '';

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('observability:');
    expect(yaml).toContain('endpoint: ""');
    expect(yaml).toContain('sample_rate: 0.25');
    expect(yaml).toContain('environment: ""');
    expect(parseRuntimeSettings(yaml).observability).toEqual(
      settings.observability,
    );

    // Tiny rates render in scientific notation; the parser must round-trip.
    settings.observability.tracing.sampleRate = 1e-7;
    const tinyYaml = renderRuntimeSettingsYaml(settings);
    expect(
      parseRuntimeSettings(tinyYaml).observability.tracing.sampleRate,
    ).toBe(1e-7);
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
      delegates: [],
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
    expect(settings.permissions.autoMode).toEqual({});

    settings.permissions.yoloMode = {
      enabled: true,
      denylist: ['npm run nuke'],
      denylistPaths: ['/opt/danger/*'],
    };
    settings.permissions.egress = {
      denylist: ['api.linkedin.com', '*.blocked.example.com'],
    };
    settings.permissions.autoMode = { model: 'sonnet' };

    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('permissions:');
    expect(yaml).toContain('yolo_mode:');
    expect(yaml).toContain('egress:');
    expect(yaml).toContain('auto_mode:');
    expect(yaml).toContain('model: sonnet');
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

  it('rejects invalid auto-mode permission settings', () => {
    expect(() =>
      parseRuntimeSettings(`permissions:
  auto_mode:
    enabled: true
`),
    ).toThrow('permissions.auto_mode.enabled is not supported');
    expect(() =>
      parseRuntimeSettings(`permissions:
  auto_mode:
    model: ""
`),
    ).toThrow('permissions.auto_mode.model must be a non-empty string');
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
    alerts: true
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
    expect(parsed.memory.dreaming.alerts).toBe(true);
    expect(parsed.memory.dreaming.embeddings).toEqual({
      enabled: true,
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
    expect(parsed.memory.llm.extractorMaxFacts).toBe(5);
    expect(parsed.memory.llm.extractorMinConfidence).toBe(0.75);
    expect(parsed.memory.maintenance.maxPending).toBe(250);
  });

  it('defaults memory.dreaming.alerts to false', () => {
    const parsed = parseRuntimeSettings(`memory:
  enabled: true
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-small
  dreaming:
    enabled: true
`);

    expect(parsed.memory.dreaming.alerts).toBe(false);
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

  it('rejects compact provider env keys', () => {
    expect(() =>
      parseRuntimeSettings(`providers:
  telegram:
    enabled: true
    bot_token_env: TELEGRAM_BOT_TOKEN
`),
    ).toThrow('providers.telegram.bot_token_env is not supported');
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

  it('rejects unsupported agent controls during settings apply validation', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.no_effort = {
      name: 'No effort',
      folder: 'no_effort',
      delegates: [],
      model: 'haiku',
      effort: 'high',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };
    settings.agents.no_thinking = {
      name: 'No thinking',
      folder: 'no_thinking',
      delegates: [],
      model: 'haiku',
      thinking: { mode: 'on' },
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };
    settings.agents.no_output_cap = {
      name: 'No output cap',
      folder: 'no_output_cap',
      delegates: [],
      model: 'opus',
      maxOutputTokens: 4096,
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };

    const result = validateLoadedRuntimeSettings(
      '/tmp/gantry-missing',
      settings,
    );
    const details = result.failure?.details.join('\n');
    expect(details).toContain(
      'agents.no_effort.effort is not supported by model haiku.',
    );
    expect(details).toContain(
      'agents.no_thinking.thinking is not supported by model haiku.',
    );
    expect(details).toContain(
      'agents.no_output_cap.max_output_tokens is not supported by model opus',
    );
    expect(details).toContain(
      'use agents.no_output_cap.effort as the output-quality lever.',
    );
  });

  it('validates agent controls against inherited job model defaults', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agent.oneTimeJobDefaultModel = 'haiku';
    settings.agent.recurringJobDefaultModel = 'haiku';
    settings.agents.inherited = {
      name: 'Inherited',
      folder: 'inherited',
      delegates: [],
      model: 'opus',
      effort: 'high',
      thinking: { mode: 'on' },
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };

    const inherited = validateLoadedRuntimeSettings(
      '/tmp/gantry-missing',
      settings,
    );
    expect(inherited.failure?.details).toEqual(
      expect.arrayContaining([
        'agents.inherited.effort is not supported by model haiku.',
        'agents.inherited.thinking is not supported by model haiku.',
      ]),
    );

    settings.agents.inherited.oneTimeJobDefaultModel = 'opus-4.6';
    settings.agents.inherited.recurringJobDefaultModel = 'sonnet';
    const overridden = validateLoadedRuntimeSettings(
      '/tmp/gantry-missing',
      settings,
    );
    expect(overridden.failure?.details.join('\n') ?? '').not.toContain(
      'agents.inherited.',
    );
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
      settings.agents.main_agent = {
        name: 'Main',
        folder: 'main_agent',
        delegates: [],
        bindings: {},
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [],
        accessPreset: 'full',
      };
      settings.providerAccounts.telegram_default = {
        agentId: 'main_agent',
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

  it('rejects channel env fallback without active provider account refs', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-provider-secret-required-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      process.env.TELEGRAM_BOT_TOKEN = 'legacy-env-token';

      const settings = createDefaultRuntimeSettings();
      settings.providers.telegram.enabled = true;
      settings.providerAccounts.telegram_default = {
        agentId: 'main_agent',
        provider: 'telegram',
        label: 'Telegram Default',
        runtimeSecretRefs: {},
      };

      const result = validateLoadedRuntimeSettings(runtimeHome, settings);

      expect(result.ok).toBe(false);
      expect(result.failure?.details.join('\n')).toContain(
        'provider_accounts.telegram_default.runtime_secret_refs.bot_token is required',
      );
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
      if (originalTelegramBotToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = originalTelegramBotToken;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('rejects enabled providers with no active provider account', () => {
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    const originalSecretEncryptionKeyring =
      process.env.SECRET_ENCRYPTION_KEYRING_JSON;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-provider-account-required-'),
    );
    try {
      process.env.GANTRY_DATABASE_URL =
        'postgres://gantry:gantry@localhost:5432/gantry_test';
      delete process.env.SECRET_ENCRYPTION_KEY;
      delete process.env.SECRET_ENCRYPTION_KEYRING_JSON;

      const settings = createDefaultRuntimeSettings();
      settings.credentialBroker.mode = 'none';
      settings.providers.telegram.enabled = true;
      settings.providerAccounts = {
        telegram_disabled: {
          agentId: 'main_agent',
          provider: 'telegram',
          label: 'Telegram Disabled',
          status: 'disabled',
          runtimeSecretRefs: { bot_token: 'gantry-secret:TELEGRAM_BOT_TOKEN' },
        },
      };

      const result = validateLoadedRuntimeSettings(runtimeHome, settings);

      expect(result.ok).toBe(false);
      expect(result.failure?.details.join('\n')).toContain(
        'providers.telegram.enabled is true but no active provider account is configured.',
      );
      expect(result.failure?.details.join('\n')).not.toContain(
        'SECRET_ENCRYPTION_KEY',
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
      if (originalSecretEncryptionKeyring === undefined) {
        delete process.env.SECRET_ENCRYPTION_KEYRING_JSON;
      } else {
        process.env.SECRET_ENCRYPTION_KEYRING_JSON =
          originalSecretEncryptionKeyring;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('renders agent_harness and rejects the retired agent_engine key', () => {
    const settings = createDefaultRuntimeSettings();
    expect(renderRuntimeSettingsYaml(settings)).not.toContain('agent_engine');
    expect(settings.agent.agentHarness).toBe('auto');

    settings.agent.agentHarness = 'deepagents';
    settings.agents.kai = {
      name: 'Kai',
      folder: 'kai',
      delegates: [],
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

  it('parses and renders per-agent tool_rules', () => {
    const parsed = parseRuntimeSettings(`agents:
  kai:
    name: Kai
    tool_rules:
      - tool: Bash
        action: block
        when:
          arg: command.options.0
          matches: ^rm\\s
        reason: destructive command
      - tool: Deploy
        action: require_prior
        prior: Test
        reason: tests must pass first
`);

    expect(parsed.agents.kai.toolRules).toEqual([
      {
        tool: 'Bash',
        action: 'block',
        when: { arg: 'command.options.0', matches: '^rm\\s' },
        reason: 'destructive command',
      },
      {
        tool: 'Deploy',
        action: 'require_prior',
        prior: 'Test',
        reason: 'tests must pass first',
      },
    ]);
    expect(
      parseRuntimeSettings(renderRuntimeSettingsYaml(parsed)).agents.kai
        .toolRules,
    ).toEqual(parsed.agents.kai.toolRules);
  });

  it('rejects malformed tool_rules with the failing field path', () => {
    const invalidRules = [
      ['tool_rules must be an array', 'tool_rules: blocked'],
      [
        'tool_rules[0].prior must be a non-empty string',
        `tool_rules:
      - tool: Deploy
        action: require_prior
        reason: missing prior`,
      ],
      [
        'tool_rules[0].when.arg must be a dot path',
        `tool_rules:
      - tool: Bash
        action: block
        when:
          arg: command..value
          matches: x
        reason: malformed arg`,
      ],
      [
        'tool_rules[0].when.matches must be a valid regular expression',
        `tool_rules:
      - tool: Bash
        action: block
        when:
          arg: command
          matches: "["
        reason: malformed regex`,
      ],
    ];

    for (const [message, rules] of invalidRules) {
      expect(() =>
        parseRuntimeSettings(`agents:
  kai:
    name: Kai
    ${rules}
`),
      ).toThrow(`agents.kai.${message}`);
    }
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
        delegates: [],
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
        delegates: [],
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
      delegates: [],
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
      delegates: [],
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
        delegates: [],
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
        delegates: [],
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
        delegates: [],
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
        delegates: [],
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
        delegates: [],
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
        delegates: [],
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
      ['requires' + 'Trigger']: true,
    });
    const second = ensureConfiguredConversationBinding(settings, {
      agentId: 'second_agent',
      agentName: 'Second',
      agentFolder: 'second_agent',
      jid: 'tg:abc:def',
      displayName: 'Second',
      trigger: '@second',
      ['requires' + 'Trigger']: true,
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

    const result = ensureConfiguredConversationBinding(settings, {
      agentId: 'main_agent',
      agentName: 'Default Agent',
      agentFolder: 'main_agent',
      jid: 'sl:C123',
      displayName: 'Engineering',
      trigger: '@Default Agent',
      ['requires' + 'Trigger']: true,
      approverIds: ['UADMIN', 'UHELPER'],
    });

    expect(
      settings.agents.main_agent.bindings[result.bindingId].providerAccountId,
    ).toBe(result.providerConnectionId);
    const conversation = Object.values(settings.conversations)[0];
    expect(conversation?.controlApprovers).toEqual(['UADMIN', 'UHELPER']);
    expect(conversation?.senderPolicy).toEqual({ allow: '*', mode: 'trigger' });
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).not.toContain('dm_access:');
    expect(yaml).toContain('    sender_policy:');
    expect(yaml).toContain('      mode: trigger');
    expect(yaml).toContain('    control_approvers: ["UADMIN","UHELPER"]');
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

  it('renders readable skill names beside exact durable skill ids', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.kai = {
      name: 'Kai',
      folder: 'kai',
      delegates: [],
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

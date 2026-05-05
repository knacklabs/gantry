import { describe, expect, it } from 'vitest';

import {
  createDefaultRuntimeSettings,
  ensureConfiguredConversationBinding,
  parseRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { validateLoadedRuntimeSettings } from '@core/config/settings/runtime-settings-validation.js';

describe('runtime settings', () => {
  it('defaults, renders, and parses agent.name', () => {
    const settings = createDefaultRuntimeSettings();
    expect(settings.agent.name).toBe('Main Agent');

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

  it('validates model defaults against the model catalog', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agent.defaultModel = 'claude-opus-4-7';
    settings.agent.oneTimeJobDefaultModel = 'sonet';

    const result = validateLoadedRuntimeSettings(
      '/tmp/myclaw-missing',
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

  it('renders and parses local desired-state agents', () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main Agent',
      folder: 'main_agent',
      persona: 'personal_assistant',
      model: 'sonnet',
      oneTimeJobDefaultModel: 'haiku',
      recurringJobDefaultModel: 'opus',
      bindings: {},
      dmAccess: [
        {
          provider: 'telegram',
          userIds: ['42'],
          adminUserId: '42',
        },
      ],
      capabilities: {
        toolIds: ['tool:read'],
        skillIds: ['skill:admin'],
        mcpServerIds: ['mcp:github'],
      },
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
      isMain: true,
      memoryScope: 'conversation',
    };

    const parsed = parseRuntimeSettings(renderRuntimeSettingsYaml(settings));

    expect(parsed.desiredState.authoritative).toBe(true);
    expect(parsed.agents.main_agent.persona).toBe('personal_assistant');
    expect(renderRuntimeSettingsYaml(parsed)).toContain(
      '    persona: personal_assistant',
    );
    expect(parsed.agents.main_agent.bindings.main_dm).toMatchObject({
      jid: 'tg:100',
      provider: 'telegram',
      name: 'Main DM',
      trigger: '@kai',
      requiresTrigger: false,
      isMain: true,
    });
    expect(parsed.bindings.main_dm).toMatchObject({
      agent: 'main_agent',
      conversation: 'main_dm',
      trigger: '@kai',
      requiresTrigger: false,
      isMain: true,
      memoryScope: 'conversation',
    });
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
      name: 'Main Agent',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: { toolIds: [], skillIds: [], mcpServerIds: [] },
    };
    settings.agents.helper = {
      name: 'Helper',
      folder: 'helper',
      bindings: {},
      dmAccess: [],
      capabilities: { toolIds: [], skillIds: [], mcpServerIds: [] },
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
      isMain: true,
      memoryScope: 'conversation',
    };
    settings.bindings.helper_team = {
      agent: 'helper',
      conversation: 'team',
      trigger: '@helper',
      addedAt: '2026-05-03T00:00:00.000Z',
      requiresTrigger: true,
      isMain: false,
      memoryScope: 'conversation',
    };
    settings.bindings.main_solo = {
      agent: 'main_agent',
      conversation: 'solo',
      trigger: '@main',
      addedAt: '2026-05-04T00:00:00.000Z',
      requiresTrigger: false,
      isMain: true,
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
      isMain: true,
    });
    const second = ensureConfiguredConversationBinding(settings, {
      agentId: 'second_agent',
      agentName: 'Second',
      agentFolder: 'second_agent',
      jid: 'tg:abc:def',
      displayName: 'Second',
      trigger: '@second',
      requiresTrigger: true,
      isMain: false,
    });

    expect(first.conversationId).not.toEqual(second.conversationId);
    expect(
      Object.values(settings.conversations).map(
        (conversation) => conversation.externalId,
      ),
    ).toEqual(['abc-def', 'abc:def']);
    expect(Object.keys(settings.bindings)).toHaveLength(2);
  });

  it('seeds onboarding approvers into default agent DM admin and conversation policy', () => {
    const settings = createDefaultRuntimeSettings();

    ensureConfiguredConversationBinding(settings, {
      agentId: 'main_agent',
      agentName: 'Main Agent',
      agentFolder: 'main_agent',
      jid: 'sl:C123',
      displayName: 'Engineering',
      trigger: '@Main Agent',
      requiresTrigger: true,
      isMain: true,
      approverIds: ['UADMIN', 'UHELPER'],
    });

    expect(settings.agents.main_agent?.dmAccess).toEqual([
      {
        provider: 'slack',
        userIds: ['UADMIN', 'UHELPER'],
        adminUserId: 'UADMIN',
      },
    ]);
    const conversation = Object.values(settings.conversations)[0];
    expect(conversation?.controlApprovers).toEqual(['UADMIN', 'UHELPER']);
    expect(conversation?.senderPolicy).toEqual({ allow: '*', mode: 'trigger' });
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('    dm_access:');
    expect(yaml).toContain('    sender_policy:');
    expect(yaml).toContain('      mode: trigger');
  });

  it('maps compact DM conversation approvers to agent DM admins', () => {
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

    expect(parsed.agents.main_agent.dmAccess).toEqual([
      {
        provider: 'telegram',
        userIds: ['5759865942'],
        adminUserId: '5759865942',
      },
    ]);
  });

  it('keeps same-agent Slack and Teams admins provider-scoped in settings', () => {
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
    dm_access:
      slack:
        allow: ["U123"]
        admin: "U123"
      teams:
        allow: ["8:orgid:abc"]
        admin: "8:orgid:abc"

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

    expect(parsed.agents.main_agent.dmAccess).toEqual([
      { provider: 'slack', userIds: ['U123'], adminUserId: 'U123' },
      {
        provider: 'teams',
        userIds: ['8:orgid:abc'],
        adminUserId: '8:orgid:abc',
      },
    ]);
    expect(parsed.conversations.sales_slack.controlApprovers).toEqual(['U123']);
    expect(parsed.conversations.sales_teams.controlApprovers).toEqual([
      '8:orgid:abc',
    ]);
  });

  it('does not render opaque skill UUIDs into human settings', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.kai = {
      name: 'Kai',
      folder: 'kai',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [
          'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
          'company-handbook',
        ],
        mcpServerIds: [],
      },
    };

    const yaml = renderRuntimeSettingsYaml(settings);

    expect(yaml).not.toContain('skill:3014949c-a616-4b2c-80e7-0bc61bb31e85');
    expect(yaml).toContain('company-handbook');
  });
});

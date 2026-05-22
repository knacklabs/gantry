import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSenderExplicitlyAllowed,
  isSenderControlAllowed,
  RuntimeSenderAllowlistConfig,
  RuntimeSenderControlAllowlistConfig,
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
  shouldLogDenied,
  shouldDropMessage,
} from '@core/platform/sender-allowlist.js';
import {
  getProvider,
  registerProvider,
} from '@core/channels/provider-registry.js';

let tmpDir: string;

function settingsPath(name = 'settings.yaml'): string {
  return path.join(tmpDir, name);
}

function renderAllow(allow: '*' | string[]): string {
  return allow === '*' ? '"*"' : JSON.stringify(allow);
}

function renderSettingsYaml(overrides: {
  telegramDefaultAllow: '*' | string[];
  telegramDefaultMode: 'trigger' | 'drop';
  telegramAgents?: Record<
    string,
    { allow: '*' | string[]; mode: 'trigger' | 'drop' }
  >;
  telegramLogDenied?: boolean;
  slackDefaultAllow?: '*' | string[];
  slackDefaultMode?: 'trigger' | 'drop';
  slackAgents?: Record<
    string,
    { allow: '*' | string[]; mode: 'trigger' | 'drop' }
  >;
  slackLogDenied?: boolean;
  telegramControlAgents?: Record<string, string[]>;
  slackControlAgents?: Record<string, string[]>;
}): string {
  const lines = [
    'defaults:',
    '  model: opus',
    'providers:',
    '  telegram:',
    '    enabled: true',
    '    default_connection: telegram_default',
    '  slack:',
    '    enabled: true',
    '    default_connection: slack_default',
    'provider_connections:',
    '  telegram_default:',
    '    provider: telegram',
    '    label: Telegram',
    '    runtime_secret_refs: {}',
    '  slack_default:',
    '    provider: slack',
    '    label: Slack',
    '    runtime_secret_refs: {}',
    'conversations:',
  ];

  for (const [folder, entry] of Object.entries(
    overrides.telegramAgents || {},
  )) {
    lines.push(`  ${folder}_conversation:`);
    lines.push('    provider_connection: telegram_default');
    lines.push('    external_id: "1"');
    lines.push('    kind: group');
    lines.push(`    display_name: ${folder}`);
    lines.push('    sender_policy:');
    lines.push(`      allow: ${renderAllow(entry.allow)}`);
    lines.push(`      mode: ${entry.mode}`);
    lines.push(
      `    control_approvers: ${JSON.stringify(overrides.telegramControlAgents?.[folder] || [])}`,
    );
  }

  for (const [folder, entry] of Object.entries(overrides.slackAgents || {})) {
    lines.push(`  ${folder}_conversation:`);
    lines.push('    provider_connection: slack_default');
    lines.push('    external_id: "C1"');
    lines.push('    kind: channel');
    lines.push(`    display_name: ${folder}`);
    lines.push('    sender_policy:');
    lines.push(`      allow: ${renderAllow(entry.allow)}`);
    lines.push(`      mode: ${entry.mode}`);
    lines.push(
      `    control_approvers: ${JSON.stringify(overrides.slackControlAgents?.[folder] || [])}`,
    );
  }

  lines.push(
    'agents:',
    ...[
      ...Object.keys(overrides.telegramAgents || {}),
      ...Object.keys(overrides.slackAgents || {}),
    ].flatMap((folder) => [
      `  ${folder}:`,
      `    name: ${folder}`,
      '    bindings: {}',
      '    sources:',
      '      skills: []',
      '      mcp_servers: []',
      '      tools: []',
      '    capabilities: []',
    ]),
    'bindings:',
    ...Object.keys(overrides.telegramAgents || {}).flatMap((folder) => [
      `  ${folder}_binding:`,
      `    agent: ${folder}`,
      `    conversation: ${folder}_conversation`,
      '    trigger: "@agent"',
      '    added_at: "2026-01-01T00:00:00.000Z"',
      '    requires_trigger: true',
      '    memory_scope: conversation',
    ]),
    ...Object.keys(overrides.slackAgents || {}).flatMap((folder) => [
      `  ${folder}_binding:`,
      `    agent: ${folder}`,
      `    conversation: ${folder}_conversation`,
      '    trigger: "@agent"',
      '    added_at: "2026-01-01T00:00:00.000Z"',
      '    requires_trigger: true',
      '    memory_scope: conversation',
    ]),
    'storage:',
    '  postgres:',
    '    url_env: GANTRY_DATABASE_URL',
    '    schema: gantry',
    'memory:',
    '  enabled: true',
    '  embeddings:',
    '    enabled: false',
    '    provider: disabled',
    '    model: text-embedding-3-large',
    '  dreaming:',
    '    enabled: false',
    '',
  );

  return lines.join('\n');
}

function writeSettings(
  config: Parameters<typeof renderSettingsYaml>[0],
  name?: string,
): string {
  const p = settingsPath(name);
  fs.writeFileSync(p, renderSettingsYaml(config), 'utf-8');
  return p;
}

function writeSameAgentMultiConversationSettings(): string {
  const p = settingsPath();
  fs.writeFileSync(
    p,
    [
      'defaults:',
      '  model: opus',
      'providers:',
      '  telegram:',
      '    enabled: true',
      '    default_connection: telegram_default',
      'provider_connections:',
      '  telegram_default:',
      '    provider: telegram',
      '    label: Telegram',
      '    runtime_secret_refs: {}',
      'conversations:',
      '  first_conversation:',
      '    provider_connection: telegram_default',
      '    external_id: "1"',
      '    kind: group',
      '    display_name: First',
      '    sender_policy:',
      '      allow: ["alice"]',
      '      mode: trigger',
      '    control_approvers: ["admin-one"]',
      '  second_conversation:',
      '    provider_connection: telegram_default',
      '    external_id: "2"',
      '    kind: group',
      '    display_name: Second',
      '    sender_policy:',
      '      allow: ["bob"]',
      '      mode: trigger',
      '    control_approvers: ["admin-two"]',
      'agents:',
      '  main_agent:',
      '    name: Default Agent',
      '    bindings: {}',
      '    sources:',
      '      skills: []',
      '      mcp_servers: []',
      '      tools: []',
      '    capabilities: []',
      'bindings:',
      '  first_binding:',
      '    agent: main_agent',
      '    conversation: first_conversation',
      '    trigger: "@agent"',
      '    added_at: "2026-01-01T00:00:00.000Z"',
      '    requires_trigger: true',
      '    memory_scope: conversation',
      '  second_binding:',
      '    agent: main_agent',
      '    conversation: second_conversation',
      '    trigger: "@agent"',
      '    added_at: "2026-01-01T00:00:00.000Z"',
      '    requires_trigger: true',
      '    memory_scope: conversation',
      'storage:',
      '  postgres:',
      '    url_env: GANTRY_DATABASE_URL',
      '    schema: gantry',
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
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
  if (!getProvider('test-provider')) {
    registerProvider({
      id: 'test-provider',
      label: 'Test Provider',
      jidPrefix: 'tp:',
      folderPrefix: 'test_',
      isGroupJid: () => false,
      formatting: 'none',
      isEnabled: () => false,
      create: () => null,
      setup: {
        envKeys: [],
        describe: () => 'test',
        run: async () => {},
      },
    });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSenderAllowlist', () => {
  it('returns allow-all defaults when file is missing', () => {
    const cfg = loadSenderAllowlist(settingsPath());
    expect(cfg.telegram.default.allow).toBe('*');
    expect(cfg.telegram.default.mode).toBe('trigger');
    expect(cfg.slack.default.allow).toBe('*');
    expect(cfg.telegram.logDenied).toBe(true);
    expect(cfg['test-provider'].default.allow).toBe('*');
    expect(cfg['test-provider'].default.mode).toBe('trigger');
  });

  it('loads provider-specific config', () => {
    const p = writeSettings({
      telegramDefaultAllow: ['alice'],
      telegramDefaultMode: 'drop',
      telegramAgents: { telegram_kai: { allow: '*', mode: 'trigger' } },
      telegramLogDenied: false,
      slackDefaultAllow: ['U123'],
      slackDefaultMode: 'trigger',
      slackAgents: { slack_ops: { allow: ['U999'], mode: 'drop' } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.telegram.default.allow).toBe('*');
    expect(cfg.telegram.logDenied).toBe(true);
    expect(cfg.telegram.conversations?.['tg:1']?.telegram_kai.mode).toBe(
      'trigger',
    );
    expect(cfg.slack.conversations?.['sl:C1']?.slack_ops.allow).toEqual([
      'U999',
    ]);
  });

  it('keeps settings-derived sender policies scoped by conversation', () => {
    const cfg = loadSenderAllowlist(writeSameAgentMultiConversationSettings());

    expect(isSenderAllowed('tg:1', 'alice', cfg, 'main_agent')).toBe(true);
    expect(isSenderAllowed('tg:1', 'bob', cfg, 'main_agent')).toBe(false);
    expect(isSenderAllowed('tg:2', 'bob', cfg, 'main_agent')).toBe(true);
    expect(isSenderAllowed('tg:2', 'alice', cfg, 'main_agent')).toBe(false);
  });

  it('returns allow-all on invalid YAML', () => {
    const p = settingsPath();
    fs.writeFileSync(p, 'version\n', 'utf-8');
    const cfg = loadSenderAllowlist(p);
    expect(cfg.telegram.default.allow).toBe('*');
  });
});

describe('isSenderAllowed', () => {
  const cfg: RuntimeSenderAllowlistConfig = {
    telegram: {
      default: { allow: '*', mode: 'trigger' },
      agents: { telegram_kai: { allow: ['alice'], mode: 'drop' } },
      logDenied: true,
    },
    slack: {
      default: { allow: ['U1'], mode: 'trigger' },
      agents: {},
      logDenied: true,
    },
    'test-provider': {
      default: { allow: ['tp-user'], mode: 'trigger' },
      agents: {},
      logDenied: true,
    },
  };

  it('allow=* allows any sender', () => {
    expect(isSenderAllowed('tg:1', 'anyone', cfg)).toBe(true);
  });

  it('uses per-agent override over provider default', () => {
    expect(isSenderAllowed('tg:1', 'alice', cfg, 'telegram_kai')).toBe(true);
    expect(isSenderAllowed('tg:1', 'bob', cfg, 'telegram_kai')).toBe(false);
  });

  it('applies provider default when folder override missing', () => {
    expect(isSenderAllowed('sl:C1', 'U1', cfg)).toBe(true);
    expect(isSenderAllowed('sl:C1', 'U2', cfg)).toBe(false);
  });

  it('supports a third provider id via provider-registry jid resolution', () => {
    expect(isSenderAllowed('tp:abc', 'tp-user', cfg)).toBe(true);
    expect(isSenderAllowed('tp:abc', 'not-allowed', cfg)).toBe(false);
  });

  it('fails closed for JIDs without a registered provider prefix', () => {
    expect(isSenderAllowed('unknown:1', 'anyone', cfg)).toBe(false);
    expect(shouldDropMessage('unknown:1', cfg)).toBe(true);
  });
});

describe('isSenderExplicitlyAllowed', () => {
  const cfg: RuntimeSenderAllowlistConfig = {
    telegram: {
      default: { allow: '*', mode: 'trigger' },
      agents: { telegram_kai: { allow: ['alice'], mode: 'drop' } },
      logDenied: true,
    },
    slack: {
      default: { allow: ['U1'], mode: 'trigger' },
      agents: {},
      logDenied: true,
    },
  };

  it('treats allow=* as not explicitly allowlisted', () => {
    expect(isSenderExplicitlyAllowed('tg:1', 'anyone', cfg)).toBe(false);
  });

  it('uses explicit per-agent allowlist when present', () => {
    expect(
      isSenderExplicitlyAllowed('tg:1', 'alice', cfg, 'telegram_kai'),
    ).toBe(true);
    expect(isSenderExplicitlyAllowed('tg:1', 'bob', cfg, 'telegram_kai')).toBe(
      false,
    );
  });

  it('uses explicit provider default allowlist for non-* defaults', () => {
    expect(isSenderExplicitlyAllowed('sl:C1', 'U1', cfg)).toBe(true);
    expect(isSenderExplicitlyAllowed('sl:C1', 'U2', cfg)).toBe(false);
  });
});

describe('sender control allowlist', () => {
  const cfg: RuntimeSenderControlAllowlistConfig = {
    telegram: {
      default: [],
      agents: { telegram_kai: ['alice'] },
    },
    slack: {
      default: ['U1'],
      agents: {},
    },
  };

  it('does not grant control access from sender allowlist wildcard', () => {
    expect(isSenderControlAllowed('tg:1', 'anyone', cfg)).toBe(false);
  });

  it('uses explicit per-agent control senders', () => {
    expect(isSenderControlAllowed('tg:1', 'alice', cfg, 'telegram_kai')).toBe(
      true,
    );
    expect(isSenderControlAllowed('tg:1', 'bob', cfg, 'telegram_kai')).toBe(
      false,
    );
  });

  it('loads control allowlist separately from sender allowlist', () => {
    const p = writeSettings({
      telegramDefaultAllow: '*',
      telegramDefaultMode: 'trigger',
      telegramAgents: { telegram_kai: { allow: '*', mode: 'trigger' } },
      slackAgents: { slack_ops: { allow: '*', mode: 'trigger' } },
      telegramControlAgents: { telegram_kai: ['alice'] },
      slackControlAgents: { slack_ops: ['U999'] },
    });
    const controlCfg = loadSenderControlAllowlist(p);
    const senderCfg = loadSenderAllowlist(p);

    expect(
      isSenderControlAllowed('tg:1', 'alice', controlCfg, 'telegram_kai'),
    ).toBe(true);
    expect(isSenderAllowed('tg:1', 'bob', senderCfg, 'telegram_kai')).toBe(
      true,
    );
    expect(
      isSenderControlAllowed('tg:1', 'bob', controlCfg, 'telegram_kai'),
    ).toBe(false);
  });

  it('keeps settings-derived control approvers scoped by conversation', () => {
    const cfg = loadSenderControlAllowlist(
      writeSameAgentMultiConversationSettings(),
    );

    expect(isSenderControlAllowed('tg:1', 'admin-one', cfg, 'main_agent')).toBe(
      true,
    );
    expect(isSenderControlAllowed('tg:1', 'admin-two', cfg, 'main_agent')).toBe(
      false,
    );
    expect(isSenderControlAllowed('tg:2', 'admin-two', cfg, 'main_agent')).toBe(
      true,
    );
    expect(isSenderControlAllowed('tg:2', 'admin-one', cfg, 'main_agent')).toBe(
      false,
    );
  });
});

describe('shouldDropMessage', () => {
  const cfg: RuntimeSenderAllowlistConfig = {
    telegram: {
      default: { allow: '*', mode: 'trigger' },
      agents: { telegram_kai: { allow: '*', mode: 'drop' } },
      logDenied: true,
    },
    slack: {
      default: { allow: '*', mode: 'drop' },
      agents: {},
      logDenied: true,
    },
  };

  it('returns false for trigger mode', () => {
    expect(shouldDropMessage('tg:1', cfg)).toBe(false);
  });

  it('returns true for drop mode', () => {
    expect(shouldDropMessage('sl:C1', cfg)).toBe(true);
  });

  it('uses per-agent mode override', () => {
    expect(shouldDropMessage('tg:1', cfg, 'telegram_kai')).toBe(true);
  });
});

describe('isTriggerAllowed and shouldLogDenied', () => {
  const cfg: RuntimeSenderAllowlistConfig = {
    telegram: {
      default: { allow: ['alice'], mode: 'trigger' },
      agents: {},
      logDenied: false,
    },
    slack: {
      default: { allow: ['U1'], mode: 'trigger' },
      agents: {},
      logDenied: true,
    },
  };

  it('allows trigger for allowed sender', () => {
    expect(isTriggerAllowed('tg:1', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for disallowed sender', () => {
    expect(isTriggerAllowed('tg:1', 'eve', cfg)).toBe(false);
  });

  it('returns provider-level logDenied flag', () => {
    expect(shouldLogDenied('tg:1', cfg)).toBe(false);
    expect(shouldLogDenied('sl:C1', cfg)).toBe(true);
  });
});

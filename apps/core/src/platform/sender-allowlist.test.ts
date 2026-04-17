import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSenderExplicitlyAllowed,
  RuntimeSenderAllowlistConfig,
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
  shouldLogDenied,
} from './sender-allowlist.js';

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
}): string {
  const lines = [
    'version: 3',
    'channels:',
    '  telegram:',
    '    enabled: true',
    '    sender_allowlist:',
    '      default:',
    `        allow: ${renderAllow(overrides.telegramDefaultAllow)}`,
    `        mode: ${overrides.telegramDefaultMode}`,
    '      agents:',
  ];

  for (const [folder, entry] of Object.entries(
    overrides.telegramAgents || {},
  )) {
    lines.push(`        ${folder}:`);
    lines.push(`          allow: ${renderAllow(entry.allow)}`);
    lines.push(`          mode: ${entry.mode}`);
  }

  lines.push(
    `      log_denied: ${overrides.telegramLogDenied === false ? 'false' : 'true'}`,
    '  slack:',
    '    enabled: true',
    '    sender_allowlist:',
    '      default:',
    `        allow: ${renderAllow(overrides.slackDefaultAllow ?? '*')}`,
    `        mode: ${overrides.slackDefaultMode ?? 'trigger'}`,
    '      agents:',
  );

  for (const [folder, entry] of Object.entries(overrides.slackAgents || {})) {
    lines.push(`        ${folder}:`);
    lines.push(`          allow: ${renderAllow(entry.allow)}`);
    lines.push(`          mode: ${entry.mode}`);
  }

  lines.push(
    `      log_denied: ${overrides.slackLogDenied === false ? 'false' : 'true'}`,
    'memory:',
    '  enabled: true',
    '  provider: sqlite',
    '  sqlite_path: store/memory.db',
    '  qmd_root: agent-memory',
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
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
  });

  it('loads channel-specific config', () => {
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
    expect(cfg.telegram.default.allow).toEqual(['alice']);
    expect(cfg.telegram.logDenied).toBe(false);
    expect(cfg.telegram.agents.telegram_kai.mode).toBe('trigger');
    expect(cfg.slack.agents.slack_ops.allow).toEqual(['U999']);
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
  };

  it('allow=* allows any sender', () => {
    expect(isSenderAllowed('tg:1', 'anyone', cfg)).toBe(true);
  });

  it('uses per-agent override over channel default', () => {
    expect(isSenderAllowed('tg:1', 'alice', cfg, 'telegram_kai')).toBe(true);
    expect(isSenderAllowed('tg:1', 'bob', cfg, 'telegram_kai')).toBe(false);
  });

  it('applies channel default when folder override missing', () => {
    expect(isSenderAllowed('sl:C1', 'U1', cfg)).toBe(true);
    expect(isSenderAllowed('sl:C1', 'U2', cfg)).toBe(false);
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

  it('uses explicit channel default allowlist for non-* defaults', () => {
    expect(isSenderExplicitlyAllowed('sl:C1', 'U1', cfg)).toBe(true);
    expect(isSenderExplicitlyAllowed('sl:C1', 'U2', cfg)).toBe(false);
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

  it('returns channel-level logDenied flag', () => {
    expect(shouldLogDenied('tg:1', cfg)).toBe(false);
    expect(shouldLogDenied('sl:C1', cfg)).toBe(true);
  });
});

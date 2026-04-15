import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  SenderAllowlistConfig,
  shouldDropMessage,
} from './sender-allowlist.js';

let tmpDir: string;

function settingsPath(name = 'settings.yaml'): string {
  return path.join(tmpDir, name);
}

function renderSettingsYaml(overrides: {
  defaultAllow: '*' | string[];
  defaultMode: 'trigger' | 'drop';
  chats?: Record<string, { allow: '*' | string[]; mode: 'trigger' | 'drop' }>;
  logDenied?: boolean;
}): string {
  const lines = [
    'version: 2',
    'channels:',
    '  telegram:',
    '    enabled: true',
    '  slack:',
    '    enabled: false',
    'features:',
    '  memory: true',
    '  embeddings: false',
    '  dreaming: false',
    'message_policy:',
    '  sender_allowlist:',
    '    default:',
    `      allow: ${
      overrides.defaultAllow === '*'
        ? '"*"'
        : JSON.stringify(overrides.defaultAllow)
    }`,
    `      mode: ${overrides.defaultMode}`,
    '    chats:',
  ];

  for (const [chat, entry] of Object.entries(overrides.chats || {})) {
    lines.push(`      ${chat}:`);
    lines.push(
      `        allow: ${entry.allow === '*' ? '"*"' : JSON.stringify(entry.allow)}`,
    );
    lines.push(`        mode: ${entry.mode}`);
  }

  lines.push(
    `    log_denied: ${overrides.logDenied === false ? 'false' : 'true'}`,
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
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
    expect(cfg.logDenied).toBe(true);
  });

  it('loads allow=* config', () => {
    const p = writeSettings({
      defaultAllow: '*',
      defaultMode: 'trigger',
      chats: {},
      logDenied: false,
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.logDenied).toBe(false);
  });

  it('loads allow=[] (deny all)', () => {
    const p = writeSettings({
      defaultAllow: [],
      defaultMode: 'trigger',
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual([]);
  });

  it('loads allow=[list]', () => {
    const p = writeSettings({
      defaultAllow: ['alice', 'bob'],
      defaultMode: 'drop',
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(['alice', 'bob']);
    expect(cfg.default.mode).toBe('drop');
  });

  it('per-chat override beats default', () => {
    const p = writeSettings({
      defaultAllow: '*',
      defaultMode: 'trigger',
      chats: { 'group-a': { allow: ['alice'], mode: 'drop' } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['group-a'].allow).toEqual(['alice']);
    expect(cfg.chats['group-a'].mode).toBe('drop');
  });

  it('returns allow-all on invalid YAML', () => {
    const p = settingsPath();
    fs.writeFileSync(p, 'version\n', 'utf-8');
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('returns allow-all on invalid schema', () => {
    const p = settingsPath();
    fs.writeFileSync(
      p,
      ['version: 2', 'channels:', '  telegram: {}', '  slack: {}'].join('\n'),
      'utf-8',
    );
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('returns allow-all when readFileSync throws non-ENOENT error', () => {
    const dirPath = path.join(tmpDir, 'is-a-directory.yaml');
    fs.mkdirSync(dirPath);
    const cfg = loadSenderAllowlist(dirPath);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
  });
});

describe('isSenderAllowed', () => {
  it('allow=* allows any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(true);
  });

  it('allow=[] denies any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(false);
  });

  it('allow=[list] allows exact match only', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice', 'bob'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('uses per-chat entry over default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'bob', cfg)).toBe(false);
    expect(isSenderAllowed('g2', 'bob', cfg)).toBe(true);
  });
});

describe('shouldDropMessage', () => {
  it('returns false for trigger mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(false);
  });

  it('returns true for drop mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'drop' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
  });

  it('per-chat mode override', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: '*', mode: 'drop' } },
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
    expect(shouldDropMessage('g2', cfg)).toBe(false);
  });
});

describe('isTriggerAllowed', () => {
  it('allows trigger for allowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for disallowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('logs when logDenied is true', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    isTriggerAllowed('g1', 'eve', cfg);
  });
});

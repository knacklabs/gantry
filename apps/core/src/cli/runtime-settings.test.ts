import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import {
  ensureRuntimeSettings,
  parseRuntimeSettingsText,
  validateRuntimeSettings,
} from './runtime-settings.js';
import { upsertEnvFile } from './env-file.js';
import { envFilePath, settingsFilePath } from './runtime-home.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-settings-test-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  return home;
}

function seedRegisteredGroups(runtimeHome: string): void {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS registered_groups (
        jid TEXT PRIMARY KEY,
        folder TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, folder) VALUES (?, ?)`,
    ).run('tg:-1001', 'telegram_kai-dev');
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, folder) VALUES (?, ?)`,
    ).run('sl:C123', 'slack_ops');
  } finally {
    db.close();
  }
}

describe('runtime-settings', () => {
  it('parses channel sender allowlist entries from yaml', () => {
    const settings = parseRuntimeSettingsText(`
channels:
  telegram:
    enabled: true
    sender_allowlist:
      default:
        allow: ["alice", "bob"]
        mode: trigger
      agents:
        telegram_kai-dev:
          allow: "*"
          mode: drop
      log_denied: true
  slack:
    enabled: false
    sender_allowlist:
      default:
        allow: "*"
        mode: trigger
      agents: {}
      log_denied: true
memory:
  enabled: true
  provider: sqlite
  sqlite_path: store/memory.db
  qmd_root: agent-memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`);

    expect(settings.channels.telegram.senderAllowlist.default.allow).toEqual([
      'alice',
      'bob',
    ]);
    expect(
      settings.channels.telegram.senderAllowlist.agents['telegram_kai-dev'],
    ).toEqual({
      allow: '*',
      mode: 'drop',
    });
  });

  it('does not enforce a schema version field', () => {
    const settings = parseRuntimeSettingsText(`
channels:
  telegram:
    enabled: false
    sender_allowlist:
      default:
        allow: "*"
        mode: trigger
      agents: {}
      log_denied: true
  slack:
    enabled: true
    sender_allowlist:
      default:
        allow: "*"
        mode: trigger
      agents: {}
      log_denied: true
memory:
  enabled: true
  provider: sqlite
  sqlite_path: store/memory.db
  qmd_root: agent-memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`);
    expect(settings.channels.telegram.enabled).toBe(false);
    expect(settings.channels.slack.enabled).toBe(true);
  });

  it('creates fixed defaults when settings.yaml is missing', () => {
    const runtimeHome = createRuntimeHome();
    const settings = ensureRuntimeSettings(runtimeHome);
    expect(settings.channels.telegram.enabled).toBe(false);
    expect(settings.channels.slack.enabled).toBe(false);
    expect(settings.channels.telegram.senderAllowlist.default.allow).toBe('*');
    expect(settings.memory.enabled).toBe(true);
    expect(settings.memory.provider).toBe('sqlite');
    expect(settings.memory.embeddings.enabled).toBe(false);
    expect(settings.memory.dreaming.enabled).toBe(false);
    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(true);
    const rendered = fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8');
    expect(rendered).toContain('memory:');
  });

  it('rejects unsupported features block and requires memory.* settings', () => {
    const runtimeHome = createRuntimeHome();
    fs.writeFileSync(
      settingsFilePath(runtimeHome),
      `
channels:
  telegram:
    enabled: false
    sender_allowlist:
      default:
        allow: "*"
        mode: trigger
      agents: {}
      log_denied: true
  slack:
    enabled: false
    sender_allowlist:
      default:
        allow: "*"
        mode: trigger
      agents: {}
      log_denied: true
features:
  memory: true
  embeddings: true
  dreaming: false
`.trimStart(),
      'utf-8',
    );

    const result = validateRuntimeSettings(runtimeHome);
    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain('features block');
  });

  it('surfaces actionable error when settings.yaml is malformed', () => {
    const runtimeHome = createRuntimeHome();
    fs.writeFileSync(settingsFilePath(runtimeHome), 'channels\n', 'utf-8');

    const result = validateRuntimeSettings(runtimeHome);
    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('settings file is invalid');
    expect(result.failure?.details.join('\n')).toContain(
      settingsFilePath(runtimeHome),
    );
  });

  it('fails validation when sender policy references unknown agent folder', () => {
    const runtimeHome = createRuntimeHome();
    seedRegisteredGroups(runtimeHome);
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'token',
      SLACK_BOT_TOKEN: 'token',
      SLACK_APP_TOKEN: 'token',
    });
    fs.writeFileSync(
      settingsFilePath(runtimeHome),
      `
channels:
  telegram:
    enabled: true
    sender_allowlist:
      default:
        allow: "*"
        mode: trigger
      agents:
        unknown_folder:
          allow: ["123"]
          mode: trigger
      log_denied: true
  slack:
    enabled: true
    sender_allowlist:
      default:
        allow: "*"
        mode: trigger
      agents: {}
      log_denied: true
memory:
  enabled: true
  provider: sqlite
  sqlite_path: store/memory.db
  qmd_root: agent-memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`.trimStart(),
      'utf-8',
    );

    const result = validateRuntimeSettings(runtimeHome);
    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain('unknown_folder');
  });
});

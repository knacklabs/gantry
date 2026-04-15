import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import {
  deriveRuntimeSettingsFromEnv,
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
version: 3
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
features:
  memory: true
  embeddings: false
  dreaming: false
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

  it('rejects legacy v2 schema', () => {
    expect(() =>
      parseRuntimeSettingsText(`
version: 2
channels:
  telegram:
    enabled: true
  slack:
    enabled: false
features:
  memory: true
  embeddings: false
  dreaming: false
`),
    ).toThrow('version must be set to 3');
  });

  it('derives defaults from env values', () => {
    const runtimeHome = createRuntimeHome();
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'tg-token',
      SLACK_BOT_TOKEN: 'slack-bot',
      SLACK_APP_TOKEN: 'slack-app',
      MEMORY_PROVIDER: 'sqlite',
      MEMORY_EMBED_PROVIDER: 'openai',
      MEMORY_DREAMING_ENABLED: 'true',
    });

    const settings = deriveRuntimeSettingsFromEnv(runtimeHome);
    expect(settings.channels.telegram.enabled).toBe(true);
    expect(settings.channels.slack.enabled).toBe(true);
    expect(settings.channels.telegram.senderAllowlist.default.allow).toBe('*');
    expect(settings.features.memory).toBe(true);
    expect(settings.features.embeddings).toBe(true);
    expect(settings.features.dreaming).toBe(true);
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
version: 3
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
features:
  memory: true
  embeddings: false
  dreaming: false
`.trimStart(),
      'utf-8',
    );

    const result = validateRuntimeSettings(runtimeHome);
    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain('unknown_folder');
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import {
  ensureRuntimeSettings,
  parseRuntimeSettings,
  validateRuntimeSettings,
} from '@core/cli/runtime-settings.js';
import { upsertEnvFile } from '@core/cli/env-file.js';
import { envFilePath, settingsFilePath } from '@core/cli/runtime-home.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-settings-test-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  return home;
}

function seedRegisteredGroups(runtimeHome: string): void {
  const dbPath = path.join(runtimeHome, 'store', 'myclaw.db');
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
    const settings = parseRuntimeSettings(`
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
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
  llm:
    models:
      extractor: claude-haiku-4-5-20251001
      dreaming: claude-sonnet-4-6
      consolidation: claude-sonnet-4-6
      session_summary: claude-haiku-4-5-20251001
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
    expect(settings.memory.llm.models.extractor).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(settings.memory.llm.models.dreaming).toBe('claude-sonnet-4-6');
  });

  it('does not enforce a schema version field', () => {
    const settings = parseRuntimeSettings(`
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
  root: memory
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

  it('parses memory scalars with inline comments consistently', () => {
    const settings = parseRuntimeSettings(`
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
memory:
  enabled: true # on
  root: "memory" # canonical root
  embeddings:
    enabled: false # keep local
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false # off
`);
    expect(settings.memory.enabled).toBe(true);
    expect(settings.memory.root).toBe('memory');
    expect(settings.memory.embeddings.enabled).toBe(false);
    expect(settings.memory.dreaming.enabled).toBe(false);
  });

  it('creates fixed defaults when settings.yaml is missing', () => {
    const runtimeHome = createRuntimeHome();
    const settings = ensureRuntimeSettings(runtimeHome);
    expect(settings.channels.telegram.enabled).toBe(false);
    expect(settings.channels.slack.enabled).toBe(false);
    expect(settings.channels.telegram.senderAllowlist.default.allow).toBe('*');
    expect(settings.memory.enabled).toBe(true);
    expect(settings.memory.root).toBe('memory');
    expect(settings.memory.embeddings.enabled).toBe(false);
    expect(settings.memory.dreaming.enabled).toBe(false);
    expect(settings.memory.llm.models.extractor).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(settings.memory.llm.models.dreaming).toBe('claude-sonnet-4-6');
    expect(settings.memory.llm.models.consolidation).toBe('claude-sonnet-4-6');
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
  root: memory
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

  it('fails validation when an enabled channel has no registered provider', () => {
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
  custom-provider:
    enabled: true
    sender_allowlist:
      default:
        allow: "*"
        mode: trigger
      agents: {}
      log_denied: true
memory:
  enabled: true
  root: memory
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
    expect(result.failure?.details.join('\n')).toContain(
      "no provider is registered for 'custom-provider'",
    );
  });

  it('parses explicit storage settings', () => {
    const settings = parseRuntimeSettings(`
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
storage:
  provider: postgres
  sqlite:
    path: store/custom.db
  postgres:
    url_env: CUSTOM_DB_URL
    schema: custom_myclaw
memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`);

    expect(settings.storage.provider).toBe('postgres');
    expect(settings.storage.sqlite.path).toBe('store/custom.db');
    expect(settings.storage.postgres.urlEnv).toBe('CUSTOM_DB_URL');
    expect(settings.storage.postgres.schema).toBe('custom_myclaw');
  });

  it('defaults storage settings when block is omitted', () => {
    const settings = parseRuntimeSettings(`
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
memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`);

    expect(settings.storage.provider).toBe('sqlite');
    expect(settings.storage.sqlite.path).toBe('store/myclaw.db');
    expect(settings.storage.postgres.urlEnv).toBe('MYCLAW_DATABASE_URL');
    expect(settings.storage.postgres.schema).toBe('myclaw');
  });

  it('rejects deprecated memory provider settings', () => {
    expect(() =>
      parseRuntimeSettings(`
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
memory:
  enabled: true
  provider: qmd
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`),
    ).toThrow(/memory\.provider is not supported/i);
  });

  it('rejects memory.embeddings.provider=none', () => {
    expect(() =>
      parseRuntimeSettings(`
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
memory:
  enabled: true
  root: memory
  embeddings:
    enabled: true
    provider: none
    model: text-embedding-3-large
  dreaming:
    enabled: false
`),
    ).toThrow(/memory\.embeddings\.provider must be disabled or openai/i);
  });

  it('rejects validation when storage.provider is postgres', () => {
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
storage:
  provider: postgres
  postgres:
    url_env: CUSTOM_DB_URL
memory:
  enabled: true
  root: memory
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
    expect(result.failure?.details.join('\n')).toMatch(
      /storage\.provider=postgres is not available/i,
    );
  });

  it('rejects validation when postgres storage env key exists in runtime env', () => {
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
storage:
  provider: postgres
  postgres:
    url_env: CUSTOM_DB_URL
memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`.trimStart(),
      'utf-8',
    );
    upsertEnvFile(envFilePath(runtimeHome), {
      CUSTOM_DB_URL: 'postgres://localhost/myclaw',
    });

    const result = validateRuntimeSettings(runtimeHome);
    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toMatch(
      /storage\.provider=postgres is not available/i,
    );
  });
});

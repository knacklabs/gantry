import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import { validateRuntimePreflight } from './runtime-preflight.js';
import { upsertEnvFile } from './env-file.js';
import { envFilePath, settingsFilePath } from './runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-preflight-test-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  return home;
}

function seedRegisteredGroups(runtimeHome: string, jids: string[]): void {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  const db = new Database(dbPath);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS registered_groups (
        jid TEXT PRIMARY KEY,
        folder TEXT NOT NULL
      );`,
    );
    const insert = db.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, folder) VALUES (?, ?)`,
    );
    for (const jid of jids) {
      const folder =
        jid.startsWith('tg:') && jids.length === 1
          ? 'telegram_kai-dev'
          : jid.startsWith('sl:')
            ? 'slack_ops'
            : `agent_${jids.indexOf(jid) + 1}`;
      insert.run(jid, folder);
    }
  } finally {
    db.close();
  }
}

function setChannelEnabled(
  runtimeHome: string,
  channel: 'telegram' | 'slack',
  enabled: boolean,
): void {
  const settings = loadRuntimeSettings(runtimeHome);
  settings.channels[channel].enabled = enabled;
  saveRuntimeSettings(runtimeHome, settings);
}

describe('validateRuntimePreflight', () => {
  it('fails when credentials are missing and points to env file', () => {
    const runtimeHome = createRuntimeHome();
    const result = validateRuntimePreflight(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('invalid');
    expect(result.failure?.details.join('\n')).toContain('Enable at least one');
    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(true);
  });

  it('fails when configured channels do not match registered chats', () => {
    const runtimeHome = createRuntimeHome();
    setChannelEnabled(runtimeHome, 'telegram', true);
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'token',
    });
    seedRegisteredGroups(runtimeHome, ['sl:C12345']);

    const result = validateRuntimePreflight(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('invalid');
    expect(result.failure?.details.join('\n')).toContain(
      'no Telegram chats are registered',
    );
  });

  it('passes when telegram config and chat mapping are valid', () => {
    const runtimeHome = createRuntimeHome();
    setChannelEnabled(runtimeHome, 'telegram', true);
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'token',
    });
    seedRegisteredGroups(runtimeHome, ['tg:123']);

    const result = validateRuntimePreflight(runtimeHome);

    expect(result.ok).toBe(true);
  });

  it('fails when settings.yaml is malformed', () => {
    const runtimeHome = createRuntimeHome();
    fs.writeFileSync(settingsFilePath(runtimeHome), 'channels\n', 'utf-8');

    const result = validateRuntimePreflight(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('settings file is invalid');
    expect(result.failure?.details.join('\n')).toContain(
      settingsFilePath(runtimeHome),
    );
  });
});

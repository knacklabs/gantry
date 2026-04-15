import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hasProcessableGroupForConfiguredChannel,
  runDoctor,
  runDoctorWithNetwork,
} from './doctor.js';
import { upsertEnvFile } from './env-file.js';
import { envFilePath } from './runtime-home.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-doctor-test-'));
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
      `CREATE TABLE IF NOT EXISTS registered_groups (jid TEXT PRIMARY KEY);`,
    );
    const insert = db.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid) VALUES (?)`,
    );
    for (const jid of jids) insert.run(jid);
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('doctor checks', () => {
  it('reports DB corruption for Telegram group registry', () => {
    const runtimeHome = createRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'store', 'messages.db'),
      'not-a-sqlite-db',
      'utf-8',
    );

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((item) => item.id === 'telegram-groups');

    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('runtime database may be corrupted');
  });

  it('re-validates Telegram token via API in network doctor', async () => {
    const runtimeHome = createRuntimeHome();
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'bad-token',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, description: 'Unauthorized' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome);
    const check = report.checks.find(
      (item) => item.id === 'telegram-token-api',
    );

    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('Unauthorized');
  });

  it('checks launchd service manager on macOS', async () => {
    vi.resetModules();
    vi.doMock('./platform.js', async () => {
      const actual =
        await vi.importActual<typeof import('./platform.js')>('./platform.js');
      return {
        ...actual,
        detectPlatform: () => 'macos',
        commandExists: (command: string) => command === 'launchctl',
      };
    });

    const mod = await import('./doctor.js');
    const report = mod.runDoctor(import.meta.url, createRuntimeHome());
    const check = report.checks.find((item) => item.id === 'service-manager');

    expect(check?.status).toBe('pass');
    expect(check?.message).toContain('launchd');
  });
});

describe('hasProcessableGroupForConfiguredChannel', () => {
  it('returns true when Telegram is configured and Telegram groups exist', () => {
    const runtimeHome = createRuntimeHome();
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'token',
    });
    seedRegisteredGroups(runtimeHome, ['tg:123']);

    expect(hasProcessableGroupForConfiguredChannel(runtimeHome)).toBe(true);
  });

  it('returns true when Slack is configured and Slack groups exist', () => {
    const runtimeHome = createRuntimeHome();
    upsertEnvFile(envFilePath(runtimeHome), {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_APP_TOKEN: 'xapp-test',
    });
    seedRegisteredGroups(runtimeHome, ['sl:C123456']);

    expect(hasProcessableGroupForConfiguredChannel(runtimeHome)).toBe(true);
  });

  it('returns false when configured channels and registered groups do not match', () => {
    const runtimeHome = createRuntimeHome();
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'token',
    });
    seedRegisteredGroups(runtimeHome, ['sl:C123456']);

    expect(hasProcessableGroupForConfiguredChannel(runtimeHome)).toBe(false);
  });
});

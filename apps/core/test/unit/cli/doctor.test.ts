import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hasProcessableGroupForConfiguredChannel,
  runDoctor,
  runDoctorWithNetwork,
} from '@core/cli/doctor.js';
import { upsertEnvFile } from '@core/cli/env-file.js';
import { envFilePath, settingsFilePath } from '@core/cli/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/cli/runtime-settings.js';

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

function seedRegisteredGroupFolders(
  runtimeHome: string,
  rows: Array<{ jid: string; folder: string }>,
): void {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  const db = new Database(dbPath);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS registered_groups (jid TEXT PRIMARY KEY, folder TEXT);`,
    );
    const insert = db.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, folder) VALUES (?, ?)`,
    );
    for (const row of rows) insert.run(row.jid, row.folder);
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

function setFeatureFlags(
  runtimeHome: string,
  flags: { memory?: boolean; embeddings?: boolean; dreaming?: boolean },
): void {
  const settings = loadRuntimeSettings(runtimeHome);
  if (flags.memory !== undefined) {
    settings.memory.enabled = flags.memory;
  }
  if (flags.embeddings !== undefined) {
    settings.memory.embeddings.enabled = flags.embeddings;
    settings.memory.embeddings.provider = flags.embeddings
      ? 'openai'
      : 'disabled';
  }
  if (flags.dreaming !== undefined) {
    settings.memory.dreaming.enabled = flags.dreaming;
  }
  saveRuntimeSettings(runtimeHome, settings);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('doctor checks', () => {
  it('creates settings.yaml on doctor run when missing', () => {
    const runtimeHome = createRuntimeHome();
    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(false);

    runDoctor(import.meta.url, runtimeHome);

    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(true);
  });

  it('runs and reports when settings.yaml is malformed', () => {
    const runtimeHome = createRuntimeHome();
    fs.writeFileSync(
      settingsFilePath(runtimeHome),
      'memory:\n  root\n',
      'utf-8',
    );

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((item) => item.id === 'runtime-settings');

    expect(report.checks.length).toBeGreaterThan(0);
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('invalid');
  });

  it('fails when no channels are enabled in settings.yaml', () => {
    const runtimeHome = createRuntimeHome();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((item) => item.id === 'runtime-settings');

    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('no channels are enabled');
  });

  it('reports IPC layout health when runtime IPC paths are writable', () => {
    const runtimeHome = createRuntimeHome();
    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((item) => item.id === 'ipc-layout');

    expect(check?.status).toBe('pass');
    expect(check?.message).toContain('IPC');
  });

  it('pre-creates IPC layout for registered group folders', () => {
    const runtimeHome = createRuntimeHome();
    seedRegisteredGroupFolders(runtimeHome, [
      { jid: 'group-1@g.us', folder: 'team_alpha' },
      { jid: 'group-2@g.us', folder: 'team_alpha' },
      { jid: 'group-3@g.us', folder: 'invalid/folder' },
    ]);

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((item) => item.id === 'ipc-layout');

    expect(check?.status).toBe('pass');
    expect(check?.message).toContain('1 registered group folder');
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'data', 'ipc', 'team_alpha', 'messages'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'data', 'ipc', 'team_alpha', 'task-responses'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'data', 'ipc', 'invalid/folder', 'messages'),
      ),
    ).toBe(false);
  });

  it('fails IPC layout check when runtime IPC paths are not writable', () => {
    const runtimeHome = createRuntimeHome();
    const ipcPathPrefix = path.join(runtimeHome, 'data', 'ipc');
    const originalMkdirSync = fs.mkdirSync;

    vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
      const targetPath = String(target);
      if (targetPath.startsWith(ipcPathPrefix)) {
        throw new Error('permission denied');
      }
      return originalMkdirSync(
        target as fs.PathLike,
        options as fs.MakeDirectoryOptions,
      );
    });

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((item) => item.id === 'ipc-layout');

    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('not writable');
  });

  it('reports DB corruption for Telegram group registry', () => {
    const runtimeHome = createRuntimeHome();
    setChannelEnabled(runtimeHome, 'telegram', true);
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
    setChannelEnabled(runtimeHome, 'telegram', true);
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
    vi.doMock('@core/cli/platform.js', async () => {
      const actual = await vi.importActual<
        typeof import('@core/cli/platform.js')
      >('@core/cli/platform.js');
      return {
        ...actual,
        detectPlatform: () => 'macos',
        commandExists: (command: string) => command === 'launchctl',
      };
    });

    const mod = await import('@core/cli/doctor.js');
    const report = mod.runDoctor(import.meta.url, createRuntimeHome());
    const check = report.checks.find((item) => item.id === 'service-manager');

    expect(check?.status).toBe('pass');
    expect(check?.message).toContain('launchd');
  });

  it('reports memory provider health and marks embeddings optional when disabled', () => {
    const runtimeHome = createRuntimeHome();
    const report = runDoctor(import.meta.url, runtimeHome);
    const providerCheck = report.checks.find(
      (item) => item.id === 'memory-provider',
    );
    const embeddingsCheck = report.checks.find(
      (item) => item.id === 'embeddings-provider',
    );

    expect(providerCheck?.status).toBe('pass');
    expect(providerCheck?.message).toContain('Memory storage is healthy');
    expect(embeddingsCheck?.status).toBe('pass');
    expect(embeddingsCheck?.message).toContain('optional');
  });

  it('warns when embeddings are enabled but OPENAI_API_KEY is missing', () => {
    const runtimeHome = createRuntimeHome();
    setFeatureFlags(runtimeHome, { memory: true, embeddings: true });
    upsertEnvFile(envFilePath(runtimeHome), {
      MEMORY_EMBED_PROVIDER: 'openai',
      OPENAI_API_KEY: null,
    });

    const report = runDoctor(import.meta.url, runtimeHome);
    const embeddingsCheck = report.checks.find(
      (item) => item.id === 'embeddings-provider',
    );

    expect(embeddingsCheck?.status).toBe('warn');
    expect(embeddingsCheck?.message).toContain('openai');
    expect(embeddingsCheck?.message).toContain('missing');
  });

  it('ignores unrelated runtime env keys while validating active settings', () => {
    const runtimeHome = createRuntimeHome();
    upsertEnvFile(envFilePath(runtimeHome), {
      AGENT_RUNTIME: 'container',
      SETUP_CONTAINER: '1',
      MEMORY_EMBED_PROVIDER: 'openai',
    });

    const report = runDoctor(import.meta.url, runtimeHome);
    const providerCheck = report.checks.find(
      (item) => item.id === 'memory-provider',
    );
    const unsupportedCheck = report.checks.find((item) =>
      item.id.startsWith('unsupported-'),
    );

    expect(unsupportedCheck).toBeUndefined();
    expect(providerCheck?.status).toBe('pass');
    expect(providerCheck?.message).toContain('Memory storage is healthy');
  });
});

describe('hasProcessableGroupForConfiguredChannel', () => {
  it('returns true when Telegram is configured and Telegram groups exist', () => {
    const runtimeHome = createRuntimeHome();
    setChannelEnabled(runtimeHome, 'telegram', true);
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'token',
    });
    seedRegisteredGroups(runtimeHome, ['tg:123']);

    expect(hasProcessableGroupForConfiguredChannel(runtimeHome)).toBe(true);
  });

  it('returns true when Slack is configured and Slack groups exist', () => {
    const runtimeHome = createRuntimeHome();
    setChannelEnabled(runtimeHome, 'slack', true);
    upsertEnvFile(envFilePath(runtimeHome), {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_APP_TOKEN: 'xapp-test',
    });
    seedRegisteredGroups(runtimeHome, ['sl:C123456']);

    expect(hasProcessableGroupForConfiguredChannel(runtimeHome)).toBe(true);
  });

  it('returns false when configured channels and registered groups do not match', () => {
    const runtimeHome = createRuntimeHome();
    setChannelEnabled(runtimeHome, 'telegram', true);
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'token',
    });
    seedRegisteredGroups(runtimeHome, ['sl:C123456']);

    expect(hasProcessableGroupForConfiguredChannel(runtimeHome)).toBe(false);
  });
});

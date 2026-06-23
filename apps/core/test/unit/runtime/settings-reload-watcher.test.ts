import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultRuntimeSettings,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import {
  CURRENT_SETTINGS_READER_VERSION,
  settingsToRevisionDocument,
} from '@core/config/settings/settings-import-service.js';
import type {
  AppendSettingsRevisionResult,
  SettingsRevision,
  SettingsRevisionRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import { startSettingsReloadWatcher } from '@core/runtime/settings-reload-watcher.js';

const runtimeHomes: string[] = [];

function makeDeps() {
  return {
    app: { loadState: vi.fn(async () => undefined) } as any,
    ops: {
      getAllConversationRoutes: vi.fn(async () => ({})),
      setConversationRoute: vi.fn(async () => undefined),
      deleteConversationRoute: vi.fn(async () => undefined),
    },
    repositories: {
      agents: {
        listAgents: vi.fn(async () => []),
        saveAgent: vi.fn(async () => undefined),
        replaceAgentCapabilityBindings: vi.fn(async () => undefined),
        disableAgent: vi.fn(async () => undefined),
      },
      tools: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => []),
      },
      skills: { getSkill: vi.fn(async () => null) },
      mcpServers: { getServer: vi.fn(async () => null) },
    },
  };
}

function stubRuntimeEnv(): void {
  vi.stubEnv(
    'GANTRY_DATABASE_URL',
    'postgres://gantry_app:pass@localhost/gantry',
  );
  vi.stubEnv(
    'GANTRY_MODEL_GATEWAY_DATABASE_URL',
    'postgres://model_gateway_app:pass@localhost/gantry?schema=model_gateway',
  );
  vi.stubEnv(
    'SECRET_ENCRYPTION_KEY',
    '123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
  );
}

async function waitFor(check: () => boolean) {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('settings reload watcher', () => {
  it('reloads valid changes and ignores invalid YAML', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-watch-'),
    );
    runtimeHomes.push(runtimeHome);
    stubRuntimeEnv();
    saveRuntimeSettings(runtimeHome, createDefaultRuntimeSettings());
    const deps = makeDeps();
    const watcher = startSettingsReloadWatcher({
      runtimeHome,
      ...deps,
      pollIntervalMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const next = createDefaultRuntimeSettings();
      next.agent.defaultModel = 'sonnet';
      saveRuntimeSettings(runtimeHome, next);
      await waitFor(() => deps.app.loadState.mock.calls.length === 1);

      fs.writeFileSync(path.join(runtimeHome, 'settings.yaml'), 'not: [yaml');
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(deps.app.loadState).toHaveBeenCalledTimes(1);
    } finally {
      watcher.close();
    }
  });

  it('mirrors local file changes forward when the latest revision is stale', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-watch-'),
    );
    runtimeHomes.push(runtimeHome);
    stubRuntimeEnv();

    const previous = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, previous);
    const deps = makeDeps();
    const repo = new FakeSettingsRevisionRepository(
      loadRuntimeSettings(runtimeHome),
    );
    const watcher = startSettingsReloadWatcher({
      runtimeHome,
      ...deps,
      settingsRevisions: repo,
      pollIntervalMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const next = createDefaultRuntimeSettings();
      next.agent.defaultModel = 'sonnet';
      saveRuntimeSettings(runtimeHome, next);

      await waitFor(() => repo.appended.length === 1);

      expect(deps.app.loadState).toHaveBeenCalledTimes(1);
      expect(repo.appended[0]?.settingsDocument).toEqual(
        settingsToRevisionDocument(next),
      );
      expect(repo.appended[0]?.createdBy).toBe('settings.yaml:auto-import');
    } finally {
      watcher.close();
    }
  });

  it('reloads without appending when the changed file matches the latest revision', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-watch-'),
    );
    runtimeHomes.push(runtimeHome);
    stubRuntimeEnv();

    const previous = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, previous);
    const next = createDefaultRuntimeSettings();
    next.agent.defaultModel = 'sonnet';
    const deps = makeDeps();
    const repo = new FakeSettingsRevisionRepository(next);
    const watcher = startSettingsReloadWatcher({
      runtimeHome,
      ...deps,
      settingsRevisions: repo,
      pollIntervalMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      saveRuntimeSettings(runtimeHome, next);

      await waitFor(() => deps.app.loadState.mock.calls.length === 1);

      expect(repo.appended).toHaveLength(0);
    } finally {
      watcher.close();
    }
  });

  it('does not append when the file matches a JSONB-normalized revision', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-watch-'),
    );
    runtimeHomes.push(runtimeHome);
    stubRuntimeEnv();

    const settings = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, settings);
    const deps = makeDeps();
    const repo = new FakeSettingsRevisionRepository(
      loadRuntimeSettings(runtimeHome),
    );
    const watcher = startSettingsReloadWatcher({
      runtimeHome,
      ...deps,
      settingsRevisions: repo,
      pollIntervalMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      saveRuntimeSettings(runtimeHome, settings);
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(repo.appended).toHaveLength(0);
      expect(deps.app.loadState).not.toHaveBeenCalled();
    } finally {
      watcher.close();
    }
  });

  it('reloads local settings when the best-effort revision lookup fails', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-watch-'),
    );
    runtimeHomes.push(runtimeHome);
    stubRuntimeEnv();

    const previous = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, previous);
    const deps = makeDeps();
    const repo = new FakeSettingsRevisionRepository(previous);
    repo.latestError = new Error('settings revisions unavailable');
    const watcher = startSettingsReloadWatcher({
      runtimeHome,
      ...deps,
      settingsRevisions: repo,
      pollIntervalMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const next = createDefaultRuntimeSettings();
      next.agent.defaultModel = 'sonnet';
      saveRuntimeSettings(runtimeHome, next);

      await waitFor(() => deps.app.loadState.mock.calls.length === 1);

      expect(repo.appended).toHaveLength(1);
    } finally {
      watcher.close();
    }
  });
});

class FakeSettingsRevisionRepository implements SettingsRevisionRepository {
  readonly appended: Parameters<
    SettingsRevisionRepository['appendSettingsRevision']
  >[0][] = [];
  latestError: Error | null = null;

  constructor(
    private readonly latestSettings: ReturnType<
      typeof createDefaultRuntimeSettings
    >,
  ) {}

  async appendSettingsRevision(
    input: Parameters<SettingsRevisionRepository['appendSettingsRevision']>[0],
  ): Promise<AppendSettingsRevisionResult> {
    this.appended.push(input);
    return {
      status: 'appended',
      revision: {
        appId: input.appId,
        revision: this.appended.length + 1,
        settingsDocument: input.settingsDocument,
        minReaderVersion: input.minReaderVersion,
        createdBy: input.createdBy,
        note: input.note ?? null,
        createdAt: new Date(0).toISOString(),
      },
    };
  }

  async getLatestSettingsRevision(appId: string): Promise<SettingsRevision> {
    if (this.latestError) throw this.latestError;
    return {
      appId,
      revision: 1,
      settingsDocument: jsonbRoundTrip(
        settingsToRevisionDocument(this.latestSettings),
      ),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'test:stale-revision',
      note: null,
      createdAt: new Date(0).toISOString(),
    };
  }

  async getSettingsRevision(): Promise<SettingsRevision | null> {
    return null;
  }

  async listRecentSettingsRevisions(): Promise<SettingsRevision[]> {
    return [];
  }
}

function jsonbRoundTrip(
  document: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}

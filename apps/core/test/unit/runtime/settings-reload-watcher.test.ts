import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
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
});

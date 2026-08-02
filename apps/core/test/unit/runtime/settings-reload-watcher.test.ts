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
import { McpBindingAuthorityChangedError } from '@core/domain/mcp/mcp-servers.js';
import { startSettingsReloadWatcher } from '@core/runtime/settings-reload-watcher.js';

const runtimeHomes: string[] = [];

function makeDeps() {
  return {
    leases: {
      tryAcquire: vi.fn(async () => ({
        release: vi.fn(async () => {}),
      })),
    },
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
        assertMcpBindingAuthorityPreconditions: vi.fn(async () => undefined),
        replaceAgentCapabilityBindingsBatch: vi.fn(async () => undefined),
        replaceAgentCapabilityBindings: vi.fn(async () => undefined),
        disableAgent: vi.fn(async () => undefined),
      },
      tools: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => []),
      },
      skills: {
        getSkill: vi.fn(async () => null),
        listSkills: vi.fn(async () => []),
        listAgentSkillBindings: vi.fn(async () => []),
      },
      mcpServers: {
        getServer: vi.fn(async () => null),
        listAgentBindings: vi.fn(async () => []),
      },
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

  it('rebases pending file edits onto current MCP binding authority before appending', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-watch-'),
    );
    runtimeHomes.push(runtimeHome);
    stubRuntimeEnv();

    const previous = createDefaultRuntimeSettings();
    previous.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: {
        skills: [],
        mcpServers: [{ id: 'mcp:sum', status: 'active', tools: ['get-sum'] }],
        tools: [],
      },
      capabilities: [],
      accessPreset: 'full',
    };
    saveRuntimeSettings(runtimeHome, previous);
    const latest = structuredClone(previous);
    latest.agent.recurringJobDefaultModel = 'haiku';
    const staleFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active' as const,
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    };
    const currentFence = {
      ...staleFence,
      allowedToolPatterns: ['echo'],
    };
    const deps = makeDeps();
    deps.repositories.mcpServers.getServer.mockResolvedValue({
      id: 'mcp:sum',
      appId: 'default',
      name: 'sum',
      status: 'active',
      createdSource: 'admin',
      riskClass: 'low',
      transport: 'http',
      config: { transport: 'http', url: 'http://127.0.0.1:3000/mcp' },
      allowedToolPatterns: ['get-sum', 'echo'],
      autoApproveToolPatterns: [],
      credentialRefs: [],
      networkHosts: [],
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    });
    deps.repositories.mcpServers.listAgentBindings.mockResolvedValue([
      currentFence,
    ]);
    const repo = new FakeSettingsRevisionRepository(latest, [
      staleFence as never,
    ]);
    const watcher = startSettingsReloadWatcher({
      runtimeHome,
      ...deps,
      settingsRevisions: repo,
      pollIntervalMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const pending = structuredClone(previous);
      pending.agent.defaultModel = 'sonnet';
      saveRuntimeSettings(runtimeHome, pending);

      await waitFor(() => repo.appended.length === 1);

      const appended = repo.appended[0]!;
      const rebased = loadRuntimeSettings(runtimeHome);
      expect(rebased.agent.defaultModel).toBe('sonnet');
      expect(rebased.agent.recurringJobDefaultModel).toBe('haiku');
      expect(rebased.agents.main_agent!.sources.mcpServers).toEqual([
        { id: 'mcp:sum', status: 'active', tools: ['echo'] },
      ]);
      expect(appended.expectedRevision).toBe(1);
      expect(appended.expectedMcpBindingAgentIds).toEqual(['agent:main_agent']);
      expect(appended.expectedMcpBindings).toEqual([currentFence]);
      expect(deps.app.loadState).toHaveBeenCalledTimes(1);
    } finally {
      watcher.close();
    }
  });

  it('reports a concurrent capability-array edit instead of dropping either side', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-watch-'),
    );
    runtimeHomes.push(runtimeHome);
    stubRuntimeEnv();

    const previous = createDefaultRuntimeSettings();
    previous.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    saveRuntimeSettings(runtimeHome, previous);
    const latest = structuredClone(previous);
    latest.agents.main_agent!.capabilities = [
      { id: 'browser.use', version: 'builtin' },
    ];
    const deps = makeDeps();
    const repo = new FakeSettingsRevisionRepository(latest);
    const watcher = startSettingsReloadWatcher({
      runtimeHome,
      ...deps,
      settingsRevisions: repo,
      pollIntervalMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const pending = structuredClone(previous);
      pending.agents.main_agent!.capabilities = [
        { id: 'mcp__gantry__service_restart', version: 'builtin' },
      ];
      saveRuntimeSettings(runtimeHome, pending);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(repo.appended).toHaveLength(0);
      expect(deps.app.loadState).not.toHaveBeenCalled();
      expect(
        loadRuntimeSettings(runtimeHome).agents.main_agent!.capabilities,
      ).toEqual([{ id: 'mcp__gantry__service_restart', version: 'builtin' }]);
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
    const mcpBindingPrecondition = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active' as const,
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    };
    const repo = new FakeSettingsRevisionRepository(next, [
      mcpBindingPrecondition as never,
    ]);
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
      expect(
        deps.repositories.agents.replaceAgentCapabilityBindingsBatch,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'default',
          expectedMcpBindingAgentIds: ['agent:main_agent'],
          expectedMcpBindings: [mcpBindingPrecondition],
        }),
      );
    } finally {
      watcher.close();
    }
  });

  it('publishes and applies a current-fence successor when a matching revision fence is stale', async () => {
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
    const staleFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active' as const,
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    };
    deps.repositories.agents.replaceAgentCapabilityBindingsBatch
      .mockRejectedValueOnce(new McpBindingAuthorityChangedError('mcp:sum'))
      .mockResolvedValueOnce(undefined);
    const repo = new FakeSettingsRevisionRepository(next, [
      staleFence as never,
    ]);
    const watcher = startSettingsReloadWatcher({
      runtimeHome,
      ...deps,
      settingsRevisions: repo,
      pollIntervalMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      saveRuntimeSettings(runtimeHome, next);

      await waitFor(
        () =>
          repo.appended.length === 1 &&
          deps.app.loadState.mock.calls.length === 1,
      );

      expect(repo.appended[0]?.createdBy).toBe(
        'settings.yaml:mcp-fence-recovery',
      );
      expect(repo.appended[0]?.note).toBe(
        'Compensate rejected MCP capability approval.',
      );
      expect(repo.appended[0]?.expectedMcpBindings).toEqual([]);
      expect(
        deps.repositories.agents.replaceAgentCapabilityBindingsBatch,
      ).toHaveBeenCalledTimes(2);
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

  it('keeps last good settings when the revision lookup fails', async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(deps.app.loadState).not.toHaveBeenCalled();
      expect(repo.appended).toHaveLength(0);
    } finally {
      watcher.close();
    }
  });

  it('retries a pending file change after transient revision lookup failure', async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(repo.appended).toHaveLength(0);

      repo.latestError = null;
      await waitFor(() => repo.appended.length === 1);

      expect(deps.app.loadState).toHaveBeenCalledTimes(1);
      expect(repo.appended[0]?.settingsDocument).toEqual(
        settingsToRevisionDocument(next),
      );
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
  private readonly appendedRevisions: SettingsRevision[] = [];

  constructor(
    private readonly latestSettings: ReturnType<
      typeof createDefaultRuntimeSettings
    >,
    private readonly mcpBindingPreconditions: SettingsRevision['mcpBindingPreconditions'] = [],
  ) {}

  async appendSettingsRevision(
    input: Parameters<SettingsRevisionRepository['appendSettingsRevision']>[0],
  ): Promise<AppendSettingsRevisionResult> {
    this.appended.push(input);
    const revision: SettingsRevision = {
      appId: input.appId,
      revision: this.appended.length + 1,
      settingsDocument: input.settingsDocument,
      minReaderVersion: input.minReaderVersion,
      createdBy: input.createdBy,
      note: input.note ?? null,
      createdAt: new Date(0).toISOString(),
      mcpBindingPreconditionAgentIds: input.expectedMcpBindingAgentIds,
      mcpBindingPreconditions: input.expectedMcpBindings,
      mcpCapabilityGrantTokens: input.mcpCapabilityGrantTokens,
    };
    this.appendedRevisions.push(revision);
    return {
      status: 'appended',
      revision,
    };
  }

  async getLatestSettingsRevision(appId: string): Promise<SettingsRevision> {
    if (this.latestError) throw this.latestError;
    const appended = this.appendedRevisions.at(-1);
    if (appended) return appended;
    const mirrored = this.appended.at(-1);
    if (mirrored) {
      return {
        appId,
        revision: this.appended.length + 1,
        settingsDocument: mirrored.settingsDocument,
        minReaderVersion: mirrored.minReaderVersion,
        createdBy: mirrored.createdBy,
        note: mirrored.note ?? null,
        createdAt: new Date(0).toISOString(),
      };
    }
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
      mcpBindingPreconditionAgentIds: [
        ...new Set(
          (this.mcpBindingPreconditions ?? []).map(
            (binding) => binding.agentId,
          ),
        ),
      ],
      mcpBindingPreconditions: this.mcpBindingPreconditions,
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

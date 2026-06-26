import { describe, expect, it, vi } from 'vitest';

import type {
  AppendSettingsRevisionResult,
  SettingsRevision,
  SettingsRevisionRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import type { ProviderConnectionRepository } from '@core/domain/ports/repositories.js';
import type { ProviderConnection } from '@core/domain/provider/provider.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import {
  CURRENT_SETTINGS_READER_VERSION,
  importFleetSettingsRevision,
  importWorkstationSettings,
  SettingsRevisionConflictError,
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
} from '@core/config/settings/settings-import-service.js';

const applyRuntimeSettingsDesiredState = vi.hoisted(() => vi.fn());

vi.mock('@core/config/settings/restart-sync.js', () => ({
  applyRuntimeSettingsDesiredState,
}));

vi.mock('@core/config/settings/runtime-settings-validation.js', () => ({
  validateLoadedRuntimeSettings: () => ({ ok: true, settings: {} }),
}));

vi.mock('@core/config/settings/desired-state-service.js', () => ({
  SettingsDesiredStateService: class {
    async validateCapabilityReferences() {
      return capabilityErrors;
    }
  },
}));

let capabilityErrors: string[] = [];

class FakeRevisionRepo implements SettingsRevisionRepository {
  rows: SettingsRevision[] = [];
  appendError: Error | null = null;
  appendConflictRevision: SettingsRevision | null = null;
  lastAppendExpectedRevision: number | null | undefined;

  async appendSettingsRevision(input: {
    appId: string;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note?: string | null;
    expectedRevision?: number | null;
  }): Promise<AppendSettingsRevisionResult> {
    this.lastAppendExpectedRevision = input.expectedRevision;
    if (this.appendError) throw this.appendError;
    if (this.appendConflictRevision) {
      this.rows.push(this.appendConflictRevision);
      return {
        status: 'conflict',
        expectedRevision: input.expectedRevision ?? 0,
        actualRevision: this.appendConflictRevision.revision,
      };
    }
    const currentRevision = this.rows.at(-1)?.revision ?? 0;
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== null &&
      input.expectedRevision !== currentRevision
    ) {
      return {
        status: 'conflict',
        expectedRevision: input.expectedRevision,
        actualRevision: currentRevision,
      };
    }
    const row: SettingsRevision = {
      appId: input.appId,
      revision: currentRevision + 1,
      settingsDocument: input.settingsDocument,
      minReaderVersion: input.minReaderVersion,
      createdBy: input.createdBy,
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return { status: 'appended', revision: row };
  }

  async getLatestSettingsRevision(): Promise<SettingsRevision | null> {
    return this.rows.at(-1) ?? null;
  }

  async getSettingsRevision(): Promise<SettingsRevision | null> {
    return null;
  }

  async listRecentSettingsRevisions(): Promise<SettingsRevision[]> {
    return [...this.rows].reverse();
  }
}

function baseDeps(repo: SettingsRevisionRepository) {
  return {
    runtimeHome: '/tmp/gantry-import-test',
    ops: {} as never,
    repositories: {} as never,
    appId: 'default' as never,
    settingsRevisions: repo,
    createdBy: 'test',
  };
}

describe('importFleetSettingsRevision', () => {
  it('workstation import can mirror the applied settings into settings revisions', async () => {
    capabilityErrors = [];
    const inputSettings = createDefaultRuntimeSettings();
    inputSettings.agent.name = 'Input Agent';
    const appliedSettings = structuredClone(inputSettings);
    appliedSettings.agent.name = 'Applied Agent';
    applyRuntimeSettingsDesiredState.mockImplementation(
      async () => appliedSettings,
    );
    const repo = new FakeRevisionRepo();

    const outcome = await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:workstation',
          note: 'mirror',
        },
      },
      inputSettings,
    );

    expect(outcome).toEqual({ revision: 1 });
    expect(repo.rows[0]).toMatchObject({
      revision: 1,
      createdBy: 'test:workstation',
      note: 'mirror',
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
    });
    expect(
      (repo.rows[0]?.settingsDocument.agent as { name?: string }).name,
    ).toBe('Applied Agent');
    expect(applyRuntimeSettingsDesiredState).toHaveBeenCalledOnce();
  });

  it('workstation import keeps applied settings when revision mirror append fails', async () => {
    capabilityErrors = [];
    const appliedSettings = createDefaultRuntimeSettings();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async () => appliedSettings,
    );
    const repo = new FakeRevisionRepo();
    repo.appendError = new Error('settings revisions unavailable');
    const logWarn = vi.fn();

    const outcome = await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:workstation',
          logWarn,
        },
      },
      createDefaultRuntimeSettings(),
    );

    expect(outcome).toEqual({});
    expect(repo.rows).toHaveLength(0);
    expect(applyRuntimeSettingsDesiredState).toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      { err: repo.appendError },
      'settings revision mirror failed after workstation settings applied',
    );
  });

  it('required workstation mirror propagates append failure', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockImplementation(async () =>
      createDefaultRuntimeSettings(),
    );
    const repo = new FakeRevisionRepo();
    repo.appendError = new Error('settings revisions unavailable');

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: {} as never,
          appId: 'default' as never,
          previousSettings: createDefaultRuntimeSettings(),
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
          },
          revisionMirrorRequired: true,
        },
        createDefaultRuntimeSettings(),
      ),
    ).rejects.toThrow('settings revisions unavailable');
  });

  it('skips a mirrored append when the applied settings already match latest', async () => {
    capabilityErrors = [];
    const appliedSettings = createDefaultRuntimeSettings();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async () => appliedSettings,
    );
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(appliedSettings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
    });

    const outcome = await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings: createDefaultRuntimeSettings(),
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:fleet',
        },
        revisionMirrorRequired: true,
      },
      createDefaultRuntimeSettings(),
    );

    expect(outcome).toEqual({});
    expect(repo.rows).toHaveLength(1);
  });

  it('required workstation mirror appends with the current expected revision', async () => {
    capabilityErrors = [];
    const previousSettings = createDefaultRuntimeSettings();
    const appliedSettings = createDefaultRuntimeSettings();
    appliedSettings.agent.name = 'new';
    applyRuntimeSettingsDesiredState.mockImplementation(
      async () => appliedSettings,
    );
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(previousSettings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
    });

    await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings,
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:fleet',
        },
        revisionMirrorRequired: true,
      },
      appliedSettings,
    );

    expect(repo.lastAppendExpectedRevision).toBe(1);
    expect(repo.rows).toHaveLength(2);
  });

  it('accepts previous settings canonicalized from the latest revision document', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async (input: { settings: unknown }) => input.settings,
    );
    const seedSettings = createDefaultRuntimeSettings();
    const latestDocument = settingsToRevisionDocument(seedSettings);
    delete latestDocument.browser;
    delete latestDocument.model_aliases;
    const previousSettings = settingsFromRevisionDocument(latestDocument);
    const nextSettings = structuredClone(previousSettings);
    nextSettings.agent.name = 'updated';
    const repo = new FakeRevisionRepo();
    repo.rows.push({
      appId: 'default',
      revision: 1,
      settingsDocument: latestDocument,
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      note: null,
      createdAt: new Date().toISOString(),
    });

    await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings,
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:fleet',
        },
        revisionMirrorRequired: true,
      },
      nextSettings,
    );

    expect(repo.lastAppendExpectedRevision).toBe(1);
    expect(repo.rows).toHaveLength(2);
    expect(
      (repo.rows[1]?.settingsDocument.agent as { name?: string }).name,
    ).toBe('updated');
  });

  it('required workstation mirror rejects stale expected revisions', async () => {
    capabilityErrors = [];
    const previousSettings = createDefaultRuntimeSettings();
    const nextSettings = createDefaultRuntimeSettings();
    nextSettings.agent.name = 'new';
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(previousSettings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
    });

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: {} as never,
          appId: 'default' as never,
          previousSettings,
          expectedRevision: 0,
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:workstation',
          },
          revisionMirrorRequired: true,
        },
        nextSettings,
      ),
    ).rejects.toMatchObject({
      name: 'SettingsRevisionConflictError',
      expectedRevision: 0,
      actualRevision: 1,
    } satisfies Partial<SettingsRevisionConflictError>);
    expect(repo.rows).toHaveLength(1);
  });

  it('keeps the required mirror revision when local apply fails after append', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    const previousSettings = createDefaultRuntimeSettings();
    const nextSettings = createDefaultRuntimeSettings();
    nextSettings.agent.name = 'committed';
    applyRuntimeSettingsDesiredState.mockRejectedValueOnce(
      new Error('local apply failed'),
    );
    const repo = new FakeRevisionRepo();
    const logWarn = vi.fn();

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: {} as never,
          appId: 'default' as never,
          previousSettings,
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
            logWarn,
          },
          revisionMirrorRequired: true,
        },
        nextSettings,
      ),
    ).rejects.toThrow('local apply failed');
    expect(logWarn).not.toHaveBeenCalled();
    expect(repo.rows).toHaveLength(1);
    expect(
      (repo.rows[0]?.settingsDocument.agent as { name?: string }).name,
    ).toBe('committed');
  });

  it('does not apply local projection when required mirror append fails', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async (input: { settings: unknown }) => {
        return input.settings;
      },
    );
    const previousSettings = createDefaultRuntimeSettings();
    previousSettings.agent.name = 'previous';
    const nextSettings = createDefaultRuntimeSettings();
    nextSettings.agent.name = 'next';
    const repo = new FakeRevisionRepo();
    repo.appendError = new Error('settings revisions unavailable');

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: {} as never,
          appId: 'default' as never,
          previousSettings,
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
          },
          revisionMirrorRequired: true,
        },
        nextSettings,
      ),
    ).rejects.toThrow('settings revisions unavailable');
    expect(applyRuntimeSettingsDesiredState).not.toHaveBeenCalled();
    expect(repo.rows).toHaveLength(0);
  });

  it('does not apply local projection when a required mirror append conflicts', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async (input: { settings: unknown }) => {
        return input.settings;
      },
    );
    const previousSettings = createDefaultRuntimeSettings();
    previousSettings.agent.name = 'previous';
    const nextSettings = createDefaultRuntimeSettings();
    nextSettings.agent.name = 'next';
    const winningSettings = createDefaultRuntimeSettings();
    winningSettings.agent.name = 'winner';
    const repo = new FakeRevisionRepo();
    repo.rows.push({
      appId: 'default',
      revision: 1,
      settingsDocument: settingsToRevisionDocument(previousSettings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'test:fleet',
      note: null,
      createdAt: new Date().toISOString(),
    });
    repo.appendConflictRevision = {
      appId: 'default',
      revision: 2,
      settingsDocument: settingsToRevisionDocument(winningSettings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'test:other-writer',
      note: null,
      createdAt: new Date().toISOString(),
    };

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: {} as never,
          appId: 'default' as never,
          previousSettings,
          expectedRevision: 1,
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
          },
          revisionMirrorRequired: true,
        },
        nextSettings,
      ),
    ).rejects.toMatchObject({
      name: 'SettingsRevisionConflictError',
      expectedRevision: 1,
      actualRevision: 2,
    } satisfies Partial<SettingsRevisionConflictError>);
    expect(applyRuntimeSettingsDesiredState).not.toHaveBeenCalled();
  });

  it('rejects provider connection provider changes before appending a required mirror revision', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    const previousSettings = createDefaultRuntimeSettings();
    const nextSettings = createDefaultRuntimeSettings();
    nextSettings.providers.slack = {
      enabled: true,
      defaultConnection: 'workspace',
    };
    nextSettings.providerConnections.workspace = {
      provider: 'slack',
      label: 'Slack',
      runtimeSecretRefs: {},
    };
    const repo = new FakeRevisionRepo();
    const providerConnections = {
      async getProviderConnection() {
        return {
          id: 'workspace',
          appId: 'default',
          providerId: 'telegram',
          label: 'Telegram',
          status: 'active',
          config: {},
          runtimeSecretRefs: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies ProviderConnection;
      },
    } as Pick<ProviderConnectionRepository, 'getProviderConnection'>;

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: { providerConnections } as never,
          appId: 'default' as never,
          previousSettings,
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
          },
          revisionMirrorRequired: true,
        },
        nextSettings,
      ),
    ).rejects.toThrow(
      'provider_connections.workspace.provider cannot change from telegram to slack; use a new provider connection id.',
    );
    expect(repo.rows).toHaveLength(0);
    expect(applyRuntimeSettingsDesiredState).not.toHaveBeenCalled();
  });

  it('appends a revision stamped with the current reader version', async () => {
    capabilityErrors = [];
    const repo = new FakeRevisionRepo();
    const outcome = await importFleetSettingsRevision(
      baseDeps(repo),
      createDefaultRuntimeSettings(),
      { note: 'first' },
    );

    expect(outcome).toEqual({ status: 'applied', revision: 1 });
    expect(repo.rows[0]?.minReaderVersion).toBe(
      CURRENT_SETTINGS_READER_VERSION,
    );
    expect(repo.rows[0]?.note).toBe('first');
  });

  it('returns path-level validation errors without appending', async () => {
    capabilityErrors = [
      'agents.x.capabilities contains unavailable capability',
    ];
    const repo = new FakeRevisionRepo();
    const outcome = await importFleetSettingsRevision(
      baseDeps(repo),
      createDefaultRuntimeSettings(),
    );

    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.errors).toEqual(capabilityErrors);
    }
    expect(repo.rows).toHaveLength(0);
  });

  it('rejects a stale expected revision with a conflict', async () => {
    capabilityErrors = [];
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: {},
      minReaderVersion: 1,
      createdBy: 'seed',
    });

    const outcome = await importFleetSettingsRevision(
      baseDeps(repo),
      createDefaultRuntimeSettings(),
      { expectedRevision: 0 },
    );

    expect(outcome).toEqual({
      status: 'conflict',
      expectedRevision: 0,
      actualRevision: 1,
    });
    expect(repo.rows).toHaveLength(1);
  });

  it('appends when the expected revision matches the current head', async () => {
    capabilityErrors = [];
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: {},
      minReaderVersion: 1,
      createdBy: 'seed',
    });

    const outcome = await importFleetSettingsRevision(
      baseDeps(repo),
      createDefaultRuntimeSettings(),
      { expectedRevision: 1 },
    );

    expect(outcome).toEqual({ status: 'applied', revision: 2 });
  });

  it('round-trips through the typed JSON document (no YAML wrapper on the wire)', () => {
    const settings = createDefaultRuntimeSettings();
    settings.runtime.deploymentMode = 'fleet';
    settings.agent.name = 'Agent "quoted" \\ path';
    settings.agent.agentHarness = 'deepagents';
    settings.memory.llm.extractorMinConfidence = 0.73;
    settings.modelAliases['fast-job'] = {
      provider: 'groq',
      providerModelId: 'llama-3.1-8b-instant',
      displayName: 'Fast Job Model',
      aliases: ['fast-job'],
      recommendedAlias: 'fast-job',
      supportedWorkloads: ['one_time_job'],
      supportsTools: true,
      source: {
        label: 'Groq supported models',
        url: 'https://console.groq.com/docs/models',
        verifiedAt: '2026-06-19',
      },
    };
    settings.agents.researcher = {
      name: 'Researcher',
      folder: 'researcher',
      agentHarness: 'anthropic_sdk',
      model: undefined,
      oneTimeJobDefaultModel: undefined,
      recurringJobDefaultModel: undefined,
      bindings: {},
      sources: {
        skills: [{ id: 'skill:browser', name: 'Browser' }],
        mcpServers: [{ id: 'mcp:docs', tools: ['search'] }],
        tools: [{ id: 'tool:local', kind: 'local_cli' }],
      },
      capabilities: [{ id: 'browser.use', version: '1' }],
      accessPreset: 'locked',
    };
    const document = settingsToRevisionDocument(settings);
    // The stored/wire document is the typed object form, not the legacy
    // `{ yaml: <string> }` wrapper.
    expect(typeof document).toBe('object');
    expect('yaml' in document).toBe(false);
    expect(
      ((document.agent as Record<string, unknown>).name as string).includes(
        '\\"',
      ),
    ).toBe(false);
    expect((document.agent as Record<string, unknown>).agent_harness).toBe(
      'deepagents',
    );
    expect(
      (document.agents as Record<string, Record<string, unknown>>).researcher
        .agent_harness,
    ).toBe('anthropic_sdk');
    expect(
      (
        (document.memory as Record<string, unknown>).llm as Record<
          string,
          unknown
        >
      ).extractor_min_confidence,
    ).toBe(0.73);
    expect(
      (
        (document.agents as Record<string, Record<string, unknown>>).researcher
          .access as Record<string, unknown>
      ).preset,
    ).toBe('locked');
    expect(
      (document.model_aliases as Record<string, Record<string, unknown>>)[
        'fast-job'
      ].provider_model_id,
    ).toBe('llama-3.1-8b-instant');
    const restored = settingsFromRevisionDocument(document);
    expect(restored.agent.name).toBe(settings.agent.name);
    expect(restored.agent.agentHarness).toBe('deepagents');
    expect(restored.memory.llm.extractorMinConfidence).toBe(0.73);
    expect(restored.runtime.deploymentMode).toBe('fleet');
    expect(restored.agents.researcher.accessPreset).toBe('locked');
    expect(restored.agents.researcher.agentHarness).toBe('anthropic_sdk');
    expect(restored.agents.researcher.capabilities).toEqual([
      { id: 'browser.use', version: '1' },
    ]);
    expect(restored.modelAliases['fast-job']?.providerModelId).toBe(
      'llama-3.1-8b-instant',
    );
  });
});

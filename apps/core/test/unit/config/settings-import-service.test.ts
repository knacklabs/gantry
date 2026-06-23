import { describe, expect, it, vi } from 'vitest';

import type {
  AppendSettingsRevisionResult,
  SettingsRevision,
  SettingsRevisionRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import {
  CURRENT_SETTINGS_READER_VERSION,
  importFleetSettingsRevision,
  importWorkstationSettings,
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

  async appendSettingsRevision(input: {
    appId: string;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note?: string | null;
    expectedRevision?: number | null;
  }): Promise<AppendSettingsRevisionResult> {
    if (this.appendError) throw this.appendError;
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

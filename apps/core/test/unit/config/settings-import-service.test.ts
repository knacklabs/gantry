import { describe, expect, it, vi } from 'vitest';

import type {
  AppendSettingsRevisionResult,
  SettingsRevision,
  SettingsRevisionRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import type { ProviderAccountRepository } from '@core/domain/ports/repositories.js';
import type { ProviderAccount } from '@core/domain/provider/provider.js';
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

function settingsWithDuplicateCapability(agentName: string) {
  const settings = createDefaultRuntimeSettings();
  settings.agents.main_agent = {
    name: agentName,
    folder: 'main_agent',
    bindings: {},
    sources: { skills: [], mcpServers: [], tools: [] },
    capabilities: [
      { id: 'browser.use', version: 'builtin' },
      { id: 'browser.use', version: 'builtin' },
    ],
    accessPreset: 'full',
  };
  return settings;
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

  it('canonicalizes old revision rows before stale revision comparison', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async (input: { settings: unknown }) => input.settings,
    );
    const previousSettings = createDefaultRuntimeSettings();
    previousSettings.providerAccounts.telegram_default = {
      agentId: 'main_agent',
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: {},
    };
    previousSettings.agents.main_agent = {
      name: 'Main Agent',
      folder: 'main_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
      relationshipMode: 'personal',
    };
    const legacyDocument = settingsToRevisionDocument(previousSettings);
    (
      legacyDocument.provider_accounts as Record<
        string,
        Record<string, unknown>
      >
    ).telegram_default.config = {};
    (
      legacyDocument.agents as Record<string, Record<string, unknown>>
    ).main_agent.relationship_mode = 'personal';
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: legacyDocument,
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
    });
    const nextSettings = structuredClone(previousSettings);
    nextSettings.agent.name = 'next';

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

    expect(repo.rows).toHaveLength(2);
    expect(
      (repo.rows[1]?.settingsDocument.agent as { name?: string }).name,
    ).toBe('next');
  });

  it('normalizes previous settings before stale revision comparison', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async (input: { settings: unknown }) => {
        return input.settings;
      },
    );
    const repo = new FakeRevisionRepo();
    const firstSettings = settingsWithDuplicateCapability('first');

    await importWorkstationSettings(
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
      firstSettings,
    );

    const secondSettings = settingsWithDuplicateCapability('second');
    await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings: structuredClone(firstSettings),
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:fleet',
        },
        revisionMirrorRequired: true,
      },
      secondSettings,
    );

    expect(repo.rows).toHaveLength(2);
    const latestAgent = (
      repo.rows[1]?.settingsDocument.agents as Record<
        string,
        { name?: string; access?: { selections?: unknown[] } }
      >
    ).main_agent;
    expect(latestAgent.name).toBe('second');
    expect(latestAgent.access?.selections).toHaveLength(1);
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
    };
    nextSettings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    nextSettings.providerAccounts.workspace = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack',
      runtimeSecretRefs: {},
    };
    const repo = new FakeRevisionRepo();
    const providerAccounts = {
      async getProviderAccount() {
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
        } satisfies ProviderAccount;
      },
    } as Pick<ProviderAccountRepository, 'getProviderAccount'>;

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: { providerAccounts } as never,
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
      'provider_accounts.workspace.provider cannot change from telegram to slack; use a new provider account id.',
    );
    expect(repo.rows).toHaveLength(0);
    expect(applyRuntimeSettingsDesiredState).not.toHaveBeenCalled();
  });

  it('appends a revision stamped with the current reader version', async () => {
    expect(CURRENT_SETTINGS_READER_VERSION).toBe(12);
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
    settings.permissions.autoMode.model = 'sonnet';
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
      permissionMode: 'auto',
      maxTurns: 14,
      maxRunTokens: 32_000,
      effort: 'medium',
      thinking: { mode: 'on', budgetTokens: 8192 },
      model: 'opus-4.6',
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
      toolRules: [
        {
          tool: 'Deploy',
          action: 'require_prior',
          prior: 'Test',
          reason: 'tests must pass first',
        },
      ],
    };
    settings.agents.analyst = {
      name: 'Analyst',
      folder: 'analyst',
      agentHarness: 'deepagents',
      model: 'gpt',
      maxOutputTokens: 4096,
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.providerAccounts.telegram_main = {
      agentId: 'researcher',
      provider: 'telegram',
      label: 'Telegram Main',
      status: 'active',
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
    };
    settings.providerAccounts.telegram_paused = {
      agentId: 'researcher',
      provider: 'telegram',
      label: 'Telegram Paused',
      status: 'disabled',
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_PAUSED_BOT_TOKEN' },
    };
    settings.conversations.shared_channel = {
      providerConnection: 'telegram_main',
      providerAccount: 'telegram_main',
      externalId: 'telegram:C123',
      kind: 'group',
      displayName: 'Shared Channel',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {
        'researcher_171.1': {
          agentId: 'researcher',
          providerAccountId: 'telegram_main',
          threadId: '171.1',
          status: 'active',
          addedAt: new Date(0).toISOString(),
          memoryScope: 'conversation',
          permissionMode: 'auto',
        },
      },
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
      (document.agents as Record<string, Record<string, unknown>>).researcher
        .permission_mode,
    ).toBe('auto');
    expect(
      (document.agents as Record<string, Record<string, unknown>>).researcher,
    ).toMatchObject({
      max_turns: 14,
      max_run_tokens: 32_000,
      effort: 'medium',
      thinking: { mode: 'on', budget_tokens: 8192 },
      tool_rules: [
        {
          tool: 'Deploy',
          action: 'require_prior',
          prior: 'Test',
          reason: 'tests must pass first',
        },
      ],
    });
    expect(
      (document.agents as Record<string, Record<string, unknown>>).analyst,
    ).toMatchObject({ max_output_tokens: 4096 });
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
        (document.permissions as Record<string, unknown>).auto_mode as Record<
          string,
          unknown
        >
      ).model,
    ).toBe('sonnet');
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
    expect(
      (document.provider_accounts as Record<string, Record<string, unknown>>)
        .telegram_main.status,
    ).toBeUndefined();
    expect(
      (document.provider_accounts as Record<string, Record<string, unknown>>)
        .telegram_paused.status,
    ).toBe('disabled');
    expect(
      (
        (document.conversations as Record<string, Record<string, unknown>>)
          .shared_channel.installed_agents as Record<
          string,
          Record<string, unknown>
        >
      )['researcher_171.1'].agent,
    ).toBe('researcher');
    expect(
      (
        (document.conversations as Record<string, Record<string, unknown>>)
          .shared_channel.installed_agents as Record<
          string,
          Record<string, unknown>
        >
      )['researcher_171.1'].permission_mode,
    ).toBe('auto');
    const restored = settingsFromRevisionDocument(document);
    expect(restored.agent.name).toBe(settings.agent.name);
    expect(restored.agent.agentHarness).toBe('deepagents');
    expect(restored.memory.llm.extractorMinConfidence).toBe(0.73);
    expect(restored.runtime.deploymentMode).toBe('fleet');
    expect(restored.agents.researcher.accessPreset).toBe('locked');
    expect(restored.agents.researcher.agentHarness).toBe('anthropic_sdk');
    expect(restored.agents.researcher.permissionMode).toBe('auto');
    expect(restored.permissions.autoMode).toEqual({ model: 'sonnet' });
    expect(restored.agents.researcher).toMatchObject({
      maxTurns: 14,
      maxRunTokens: 32_000,
      effort: 'medium',
      thinking: { mode: 'on', budgetTokens: 8192 },
      toolRules: [
        {
          tool: 'Deploy',
          action: 'require_prior',
          prior: 'Test',
          reason: 'tests must pass first',
        },
      ],
    });
    expect(restored.agents.analyst.maxOutputTokens).toBe(4096);
    expect(restored.agents.researcher.capabilities).toEqual([
      { id: 'browser.use', version: '1' },
    ]);
    expect(restored.modelAliases['fast-job']?.providerModelId).toBe(
      'llama-3.1-8b-instant',
    );
    expect(restored.providerAccounts.telegram_main).toMatchObject({
      agentId: 'researcher',
      provider: 'telegram',
      label: 'Telegram Main',
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
    });
    expect(restored.providerAccounts.telegram_paused?.status).toBe('disabled');
    expect(
      restored.conversations.shared_channel.installedAgents['researcher_171.1']
        ?.agentId,
    ).toBe('researcher');
    expect(
      restored.conversations.shared_channel.installedAgents['researcher_171.1']
        ?.permissionMode,
    ).toBe('auto');
  });

  it('migrates legacy per-agent bindings when reading settings revisions', () => {
    const restored = settingsFromRevisionDocument({
      providers: { slack: { enabled: true } },
      provider_accounts: {
        slack_main: {
          agent: 'control',
          provider: 'slack',
          label: 'Slack Main',
        },
      },
      conversations: {
        shared_channel: {
          provider_account: 'slack_main',
          external_id: 'C123',
          kind: 'channel',
          display_name: 'Shared',
        },
      },
      agents: {
        control: {
          name: 'Control',
          bindings: {
            control_binding: {
              jid: 'sl:C123',
              providerAccountId: 'slack_main',
              trigger: '@control',
              addedAt: '2026-01-01T00:00:00.000Z',
              requiresTrigger: true,
            },
          },
        },
      },
    });

    expect(
      restored.conversations.shared_channel.installedAgents.control_binding,
    ).toMatchObject({
      agentId: 'control',
      providerAccountId: 'slack_main',
      trigger: '@control',
      requiresTrigger: true,
    });
    expect(Object.values(restored.agents.control.bindings)[0]).toMatchObject({
      jid: 'sl:C123',
      trigger: '@control',
      requiresTrigger: true,
    });
  });
});

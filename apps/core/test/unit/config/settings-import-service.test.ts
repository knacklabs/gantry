import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import type {
  AppendSettingsRevisionResult,
  SettingsRevision,
  SettingsRevisionRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import type { McpBindingAuthorityPrecondition } from '@core/domain/mcp/mcp-servers.js';
import type { ProviderAccountRepository } from '@core/domain/ports/repositories.js';
import type { ProviderAccount } from '@core/domain/provider/provider.js';
import { McpBindingAuthorityChangedError } from '@core/domain/mcp/mcp-servers.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import { parseRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import {
  CURRENT_SETTINGS_READER_VERSION,
  applySettingsRevisionWithMcpFenceRecovery,
  importFleetSettingsRevision,
  importWorkstationSettings,
  SettingsIncompatibleReaderError,
  SettingsRevisionConflictError,
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
} from '@core/config/settings/settings-import-service.js';
import { mcpCapabilityGrantTokenKey } from '@core/config/settings/mcp-capability-grant-provenance.js';

const {
  addActiveMcpSourcesToRuntimeSettings,
  applyRuntimeSettingsDesiredState,
  snapshotConfiguredMcpBindingAuthority,
} = vi.hoisted(() => ({
  addActiveMcpSourcesToRuntimeSettings: vi.fn(),
  applyRuntimeSettingsDesiredState: vi.fn(),
  snapshotConfiguredMcpBindingAuthority: vi.fn(),
}));
const releaseLease = vi.fn(async () => {});
const leases = {
  tryAcquire: vi.fn(async () => ({ release: releaseLease })),
};

vi.mock('@core/config/settings/restart-sync.js', () => ({
  addAllMcpSourcesToRuntimeSettings: addActiveMcpSourcesToRuntimeSettings,
  addActiveMcpSourcesToRuntimeSettings,
  applyRuntimeSettingsDesiredState,
  snapshotConfiguredMcpBindingAuthority,
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
  lastAppendExpectedMcpBindingAgentIds: string[] | undefined;
  lastAppendExpectedMcpBindings: McpBindingAuthorityPrecondition[] | undefined;

  async appendSettingsRevision(input: {
    appId: string;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note?: string | null;
    expectedRevision?: number | null;
    expectedMcpBindingAgentIds?: string[];
    expectedMcpBindings?: McpBindingAuthorityPrecondition[];
    mcpCapabilityGrantTokens?: Record<string, string>;
  }): Promise<AppendSettingsRevisionResult> {
    this.lastAppendExpectedRevision = input.expectedRevision;
    this.lastAppendExpectedMcpBindingAgentIds =
      input.expectedMcpBindingAgentIds;
    this.lastAppendExpectedMcpBindings = input.expectedMcpBindings;
    if (this.appendError) throw this.appendError;
    if (this.appendConflictRevision) {
      const conflictingRevision = this.appendConflictRevision;
      this.appendConflictRevision = null;
      this.rows.push(conflictingRevision);
      return {
        status: 'conflict',
        expectedRevision: input.expectedRevision ?? 0,
        actualRevision: conflictingRevision.revision,
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
      mcpBindingPreconditionAgentIds: (input.expectedMcpBindingAgentIds ??
        (input.expectedMcpBindings === undefined
          ? undefined
          : [
              ...new Set(
                input.expectedMcpBindings.map((binding) => binding.agentId),
              ),
            ])) as never,
      mcpBindingPreconditions: input.expectedMcpBindings,
      mcpCapabilityGrantTokens: input.mcpCapabilityGrantTokens,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return { status: 'appended', revision: row };
  }

  async getLatestSettingsRevision(): Promise<SettingsRevision | null> {
    return this.rows.at(-1) ?? null;
  }

  async getSettingsRevision(input: {
    appId: string;
    revision: number;
  }): Promise<SettingsRevision | null> {
    return (
      this.rows.find(
        (row) => row.appId === input.appId && row.revision === input.revision,
      ) ?? null
    );
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
    delegates: [],
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
  it('carries MCP grant provenance through unrelated successors and replaces it on reapproval', async () => {
    capabilityErrors = [];
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [{ id: 'mcp:sum' }], tools: [] },
      capabilities: [{ id: 'mcp.sum.read.reviewed', version: 'catalog' }],
      accessPreset: 'full',
    };
    const tokenKey = mcpCapabilityGrantTokenKey(
      'main_agent',
      settings.agents.main_agent.capabilities[0]!,
    );
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(settings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      mcpCapabilityGrantTokens: { [tokenKey]: 'grant:first' },
    });

    const unrelatedSuccessor = structuredClone(settings);
    unrelatedSuccessor.agents.main_agent.name = 'Renamed';
    await importFleetSettingsRevision(baseDeps(repo), unrelatedSuccessor, {
      expectedRevision: 1,
    });
    expect(repo.rows[1]?.mcpCapabilityGrantTokens).toEqual({
      [tokenKey]: 'grant:first',
    });

    const reapprovedSuccessor = structuredClone(unrelatedSuccessor);
    reapprovedSuccessor.agents.main_agent.name = 'Renamed again';
    await importFleetSettingsRevision(baseDeps(repo), reapprovedSuccessor, {
      expectedRevision: 2,
      mcpCapabilityGrantTokens: { [tokenKey]: 'grant:second' },
    });
    expect(repo.rows[2]?.mcpCapabilityGrantTokens).toEqual({
      [tokenKey]: 'grant:second',
    });
  });

  it('returns revision_created when workstation import appends a revision', async () => {
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
        previousSettings: createDefaultRuntimeSettings(),
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:workstation',
          note: 'mirror',
        },
      },
      inputSettings,
    );

    expect(outcome).toEqual({ status: 'revision_created', revision: 1 });
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
        previousSettings: createDefaultRuntimeSettings(),
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:workstation',
          logWarn,
        },
      },
      createDefaultRuntimeSettings(),
    );

    expect(outcome).toEqual({ status: 'applied_no_revision' });
    expect(repo.rows).toHaveLength(0);
    expect(applyRuntimeSettingsDesiredState).toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      { err: repo.appendError },
      'settings revision mirror failed after workstation settings applied',
    );
  });

  it('returns applied_no_revision without a revision mirror', async () => {
    capabilityErrors = [];
    const settings = createDefaultRuntimeSettings();
    const previousSettings = structuredClone(settings);
    applyRuntimeSettingsDesiredState.mockResolvedValue(settings);

    const outcome = await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings,
      },
      settings,
    );

    expect(outcome).toEqual({ status: 'applied_no_revision' });
    expect(applyRuntimeSettingsDesiredState).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardCorrected: false,
        previousSettings,
      }),
    );
  });

  it('uses forward correction for an explicit revision-authority projection', async () => {
    capabilityErrors = [];
    const settings = createDefaultRuntimeSettings();
    applyRuntimeSettingsDesiredState.mockReset();
    applyRuntimeSettingsDesiredState.mockResolvedValue(settings);

    await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        projectionAuthority: 'revision',
      },
      settings,
    );

    expect(applyRuntimeSettingsDesiredState).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardCorrected: true,
        previousSettings: undefined,
      }),
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
          leases,
          revisionMirrorRequired: true,
        },
        createDefaultRuntimeSettings(),
      ),
    ).rejects.toThrow('settings revisions unavailable');
  });

  it('returns no_op when the required mirror already matches latest', async () => {
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
        leases,
        revisionMirrorRequired: true,
      },
      createDefaultRuntimeSettings(),
    );

    expect(outcome).toEqual({ status: 'no_op' });
    expect(repo.rows).toHaveLength(1);
  });

  it('appends a successor when reapproval changes only MCP grant provenance', async () => {
    capabilityErrors = [];
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [{ id: 'mcp.sum.read.reviewed', version: 'catalog' }],
      accessPreset: 'full',
    };
    applyRuntimeSettingsDesiredState.mockImplementation(
      async (input: { settings: unknown }) => input.settings,
    );
    const tokenKey = mcpCapabilityGrantTokenKey(
      'main_agent',
      settings.agents.main_agent.capabilities[0]!,
    );
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(settings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      mcpCapabilityGrantTokens: { [tokenKey]: 'grant:first' },
    });

    const outcome = await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings: settings,
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'permission:mcp-capability',
        },
        leases,
        revisionMirrorRequired: true,
        mcpCapabilityGrantTokens: { [tokenKey]: 'grant:second' },
      },
      settings,
    );

    expect(outcome).toEqual({ status: 'revision_created', revision: 2 });
    expect(repo.rows[1]?.mcpCapabilityGrantTokens).toEqual({
      [tokenKey]: 'grant:second',
    });
  });

  it('appends a successor revision when only the persisted MCP fence changed', async () => {
    capabilityErrors = [];
    const settings = createDefaultRuntimeSettings();
    applyRuntimeSettingsDesiredState.mockResolvedValue(settings);
    const repo = new FakeRevisionRepo();
    const oldFence = {
      id: 'agent-mcp-binding:agent:test:mcp:sum',
      appId: 'default',
      agentId: 'agent:test',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...oldFence,
      required: true,
      permissionPolicyIds: ['permission-policy:mcp:sum'],
      conversationId: 'conversation:review',
      threadId: 'thread:review:topic',
    } as McpBindingAuthorityPrecondition;
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(settings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      expectedMcpBindings: [oldFence],
    });

    const outcome = await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings: settings,
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:fleet',
        },
        leases,
        revisionMirrorRequired: true,
        expectedMcpBindings: [currentFence],
      },
      settings,
    );

    expect(outcome).toEqual({ status: 'revision_created', revision: 2 });
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[1]?.settingsDocument).toEqual(
      repo.rows[0]?.settingsDocument,
    );
    expect(repo.rows[1]?.mcpBindingPreconditions).toEqual([currentFence]);
    expect(repo.lastAppendExpectedRevision).toBe(1);
  });

  it('refreshes rather than clears a persisted MCP fence on a successor revision', async () => {
    capabilityErrors = [];
    const settings = createDefaultRuntimeSettings();
    applyRuntimeSettingsDesiredState.mockResolvedValue(settings);
    const repo = new FakeRevisionRepo();
    const oldFence = {
      id: 'agent-mcp-binding:agent:test:mcp:sum',
      appId: 'default',
      agentId: 'agent:test',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...oldFence,
      required: true,
      permissionPolicyIds: ['permission-policy:mcp:sum'],
    } as McpBindingAuthorityPrecondition;
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(settings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      expectedMcpBindingAgentIds: ['agent:test' as never],
      expectedMcpBindings: [oldFence],
    });
    snapshotConfiguredMcpBindingAuthority.mockResolvedValueOnce({
      agentIds: ['agent:test'],
      bindings: [currentFence],
    });

    const outcome = await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings: settings,
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'projection-sync',
        },
        leases,
        revisionMirrorRequired: true,
      },
      settings,
    );

    expect(outcome).toEqual({ status: 'revision_created', revision: 2 });
    expect(repo.rows[1]?.settingsDocument).toEqual(
      repo.rows[0]?.settingsDocument,
    );
    expect(repo.rows[1]?.mcpBindingPreconditionAgentIds).toEqual([
      'agent:test',
    ]);
    expect(repo.rows[1]?.mcpBindingPreconditions).toEqual([currentFence]);
    expect(repo.lastAppendExpectedRevision).toBe(1);
  });

  it('projects current MCP authority into a required workstation successor', async () => {
    capabilityErrors = [];
    addActiveMcpSourcesToRuntimeSettings.mockReset();
    snapshotConfiguredMcpBindingAuthority.mockReset();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async (input: { settings: unknown }) => input.settings,
    );
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
    const oldFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...oldFence,
      allowedToolPatterns: ['echo'],
    } as McpBindingAuthorityPrecondition;
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(previous),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      expectedMcpBindingAgentIds: ['agent:main_agent' as never],
      expectedMcpBindings: [oldFence],
    });
    addActiveMcpSourcesToRuntimeSettings.mockImplementationOnce(
      async (input: { settings: typeof previous }) => {
        input.settings.agents.main_agent.sources.mcpServers[0]!.tools = [
          'echo',
        ];
        return [currentFence];
      },
    );
    snapshotConfiguredMcpBindingAuthority.mockResolvedValueOnce({
      agentIds: ['agent:main_agent'],
      bindings: [currentFence],
    });
    const next = structuredClone(previous);
    next.agent.defaultModel = 'sonnet';

    const outcome = await importWorkstationSettings(
      {
        runtimeHome: '/tmp/gantry-import-test',
        ops: {} as never,
        repositories: {} as never,
        appId: 'default' as never,
        previousSettings: previous,
        revisionMirror: {
          settingsRevisions: repo,
          createdBy: 'test:fleet',
        },
        leases,
        revisionMirrorRequired: true,
      },
      next,
    );

    expect(outcome).toEqual({ status: 'revision_created', revision: 2 });
    const successor = settingsFromRevisionDocument(
      repo.rows[1]!.settingsDocument,
    );
    expect(successor.agent.defaultModel).toBe('sonnet');
    expect(successor.agents.main_agent.sources.mcpServers).toEqual([
      { id: 'mcp:sum', status: 'active', tools: ['echo'] },
    ]);
    expect(repo.rows[1]?.mcpBindingPreconditions).toEqual([currentFence]);
  });

  it('projects current MCP authority into a direct fleet successor before appending', async () => {
    capabilityErrors = [];
    addActiveMcpSourcesToRuntimeSettings.mockReset();
    snapshotConfiguredMcpBindingAuthority.mockReset();
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
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
    const repo = new FakeRevisionRepo();
    const fence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...fence,
      allowedToolPatterns: ['echo'],
    } as McpBindingAuthorityPrecondition;
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(settings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      expectedMcpBindingAgentIds: ['agent:main_agent' as never],
      expectedMcpBindings: [fence],
    });
    addActiveMcpSourcesToRuntimeSettings.mockImplementationOnce(
      async (input: { settings: typeof settings }) => {
        input.settings.agents.main_agent!.sources.mcpServers[0]!.tools = [
          'echo',
        ];
        return [currentFence];
      },
    );
    snapshotConfiguredMcpBindingAuthority.mockResolvedValueOnce({
      agentIds: ['agent:main_agent'],
      bindings: [currentFence],
    });

    const outcome = await importFleetSettingsRevision(baseDeps(repo), settings);

    expect(outcome).toEqual({ status: 'applied', revision: 2 });
    expect(repo.lastAppendExpectedRevision).toBe(1);
    expect(repo.lastAppendExpectedMcpBindingAgentIds).toEqual([
      'agent:main_agent',
    ]);
    expect(repo.lastAppendExpectedMcpBindings).toEqual([currentFence]);
    expect(
      settingsFromRevisionDocument(repo.rows[1]!.settingsDocument).agents
        .main_agent!.sources.mcpServers,
    ).toEqual([{ id: 'mcp:sum', status: 'active', tools: ['echo'] }]);
  });

  it('returns applied_no_revision when the optional mirror already matches after apply', async () => {
    capabilityErrors = [];
    const appliedSettings = createDefaultRuntimeSettings();
    applyRuntimeSettingsDesiredState.mockResolvedValue(appliedSettings);
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
          createdBy: 'test:workstation',
        },
      },
      appliedSettings,
    );

    expect(outcome).toEqual({ status: 'applied_no_revision' });
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
    const expectedBinding = {
      id: 'agent-mcp-binding:agent:test:mcp:sum',
      appId: 'default',
      agentId: 'agent:test',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z',
    } as McpBindingAuthorityPrecondition;
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
        leases,
        revisionMirrorRequired: true,
        expectedMcpBindings: [expectedBinding],
      },
      appliedSettings,
    );

    expect(repo.lastAppendExpectedRevision).toBe(1);
    expect(repo.lastAppendExpectedMcpBindings).toEqual([expectedBinding]);
    expect(repo.rows).toHaveLength(2);
  });

  it('projects a required mutation through the app coordinator using the created revision', async () => {
    capabilityErrors = [];
    leases.tryAcquire.mockClear();
    releaseLease.mockClear();
    applyRuntimeSettingsDesiredState.mockReset();
    applyRuntimeSettingsDesiredState.mockImplementation(
      async (input: { settings: unknown }) => input.settings,
    );
    const previousSettings = createDefaultRuntimeSettings();
    const nextSettings = createDefaultRuntimeSettings();
    nextSettings.agent.name = 'next';
    const repo = new FakeRevisionRepo();

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
        leases,
        revisionMirrorRequired: true,
      },
      nextSettings,
    );

    expect(leases.tryAcquire).toHaveBeenCalledWith(
      'settings-projector:default',
    );
    expect(releaseLease).toHaveBeenCalledOnce();
    const applyInput = applyRuntimeSettingsDesiredState.mock.calls[0]?.[0];
    expect(applyInput).toEqual(
      expect.objectContaining({ forwardCorrected: true }),
    );
    expect(applyInput).not.toHaveProperty('previousSettings');
    expect(applyInput).not.toHaveProperty('projectionRevision');
    expect(applyInput).not.toHaveProperty('settingsRevisions');
  });

  it('keeps failed superseding-head projection in forward-correction mode', async () => {
    capabilityErrors = [];
    leases.tryAcquire.mockClear();
    releaseLease.mockClear();
    applyRuntimeSettingsDesiredState.mockReset();
    const previousSettings = createDefaultRuntimeSettings();
    previousSettings.agent.name = 'previous';
    const targetSettings = createDefaultRuntimeSettings();
    targetSettings.agent.name = 'target';
    const supersedingSettings = createDefaultRuntimeSettings();
    supersedingSettings.agent.name = 'superseding';
    const repo = new FakeRevisionRepo();
    const supersedingHead: SettingsRevision = {
      appId: 'default',
      revision: 2,
      settingsDocument: settingsToRevisionDocument(supersedingSettings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'test:newer-writer',
      note: null,
      createdAt: new Date().toISOString(),
    };
    vi.spyOn(repo, 'getLatestSettingsRevision')
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        repo.rows.push(supersedingHead);
        return supersedingHead;
      });
    const failure = new Error('superseding projection failed');
    applyRuntimeSettingsDesiredState.mockRejectedValueOnce(failure);

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
          leases,
          revisionMirrorRequired: true,
        },
        targetSettings,
      ),
    ).rejects.toBe(failure);

    expect(applyRuntimeSettingsDesiredState).toHaveBeenCalledWith({
      runtimeHome: '/tmp/gantry-import-test',
      settings: expect.objectContaining({
        agent: expect.objectContaining({ name: 'superseding' }),
      }),
      ops: expect.anything(),
      repositories: expect.anything(),
      appId: 'default',
      forwardCorrected: true,
      reloadRuntimeState: undefined,
    });
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it('rejects a superseding head that requires a newer settings reader', async () => {
    capabilityErrors = [];
    leases.tryAcquire.mockClear();
    releaseLease.mockClear();
    applyRuntimeSettingsDesiredState.mockReset();
    const previousSettings = createDefaultRuntimeSettings();
    previousSettings.agent.name = 'previous';
    const nextSettings = createDefaultRuntimeSettings();
    nextSettings.agent.name = 'target';
    const unreadableSettings = createDefaultRuntimeSettings();
    unreadableSettings.agent.name = 'unreadable';
    const repo = new FakeRevisionRepo();
    const supersedingHead: SettingsRevision = {
      appId: 'default',
      revision: 2,
      settingsDocument: settingsToRevisionDocument(unreadableSettings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION + 1,
      createdBy: 'test:newer-writer',
      note: null,
      createdAt: new Date().toISOString(),
    };
    vi.spyOn(repo, 'getLatestSettingsRevision')
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        repo.rows.push(supersedingHead);
        return supersedingHead;
      });

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
          leases,
          revisionMirrorRequired: true,
        },
        nextSettings,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SettingsIncompatibleReaderError>>({
        name: 'SettingsIncompatibleReaderError',
        revision: 2,
        minReaderVersion: CURRENT_SETTINGS_READER_VERSION + 1,
        readerVersion: CURRENT_SETTINGS_READER_VERSION,
      }),
    );
    expect(applyRuntimeSettingsDesiredState).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it('rejects an exact head that requires a newer settings reader', async () => {
    capabilityErrors = [];
    leases.tryAcquire.mockClear();
    releaseLease.mockClear();
    applyRuntimeSettingsDesiredState.mockReset();
    const settings = createDefaultRuntimeSettings();
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(settings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION + 1,
      createdBy: 'newer-runtime',
    });

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: {} as never,
          appId: 'default' as never,
          previousSettings: settings,
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
          },
          leases,
          revisionMirrorRequired: true,
        },
        settings,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SettingsIncompatibleReaderError>>({
        name: 'SettingsIncompatibleReaderError',
        revision: 1,
        minReaderVersion: CURRENT_SETTINGS_READER_VERSION + 1,
        readerVersion: CURRENT_SETTINGS_READER_VERSION,
      }),
    );
    expect(applyRuntimeSettingsDesiredState).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledOnce();
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
      delegates: [],
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
        leases,
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
        leases,
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
        leases,
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
          leases,
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
          leases,
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

  it('preserves a tokenless selection when a fenced revision loses the source race', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    addActiveMcpSourcesToRuntimeSettings.mockReset();
    const previousSettings = createDefaultRuntimeSettings();
    previousSettings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [{ id: 'mcp:sum' }], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    const nextSettings = structuredClone(previousSettings);
    nextSettings.agents.main_agent.capabilities.push({
      id: 'mcp.sum.read.reviewed',
      version: 'catalog',
    });
    const reviewedFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...reviewedFence,
      status: 'disabled',
    } as McpBindingAuthorityPrecondition;
    applyRuntimeSettingsDesiredState.mockRejectedValueOnce(
      new McpBindingAuthorityChangedError('mcp:sum'),
    );
    addActiveMcpSourcesToRuntimeSettings.mockImplementationOnce(
      async (input: { settings: typeof previousSettings }) => {
        input.settings.agents.main_agent.sources.mcpServers[0]!.status =
          'disabled';
        return [currentFence];
      },
    );
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
          expectedRevision: 1,
          expectedMcpBindings: [reviewedFence],
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
          },
          leases,
          revisionMirrorRequired: true,
        },
        nextSettings,
      ),
    ).rejects.toThrow('changed during capability approval');

    expect(repo.rows).toHaveLength(3);
    expect(repo.rows[1]?.settingsDocument).toEqual(
      settingsToRevisionDocument(nextSettings),
    );
    const recoveredSettings = structuredClone(nextSettings);
    recoveredSettings.agents.main_agent.sources.mcpServers[0]!.status =
      'disabled';
    expect(repo.rows[2]?.settingsDocument).toEqual(
      settingsToRevisionDocument(recoveredSettings),
    );
    expect(repo.rows[2]?.mcpBindingPreconditions).toEqual([currentFence]);
    expect(repo.rows[2]?.note).toBe(
      'Compensate rejected MCP capability approval.',
    );
    expect(repo.lastAppendExpectedRevision).toBe(2);
  });

  it('supersedes a tokened MCP approval after reload failure so restart cannot replay the grant', async () => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    addActiveMcpSourcesToRuntimeSettings.mockReset();
    const previousSettings = createDefaultRuntimeSettings();
    previousSettings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [{ id: 'mcp:sum' }], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    const rejectedSettings = structuredClone(previousSettings);
    const rejectedCapability = {
      id: 'mcp.sum.read.reviewed',
      version: 'catalog',
    } as const;
    rejectedSettings.agents.main_agent.capabilities.push(rejectedCapability);
    const grantTokenKey = mcpCapabilityGrantTokenKey(
      'main_agent',
      rejectedCapability,
    );
    const reviewedFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    applyRuntimeSettingsDesiredState.mockRejectedValueOnce(
      new Error('reload failed'),
    );
    addActiveMcpSourcesToRuntimeSettings.mockResolvedValue([reviewedFence]);
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
          expectedRevision: 1,
          expectedMcpBindings: [reviewedFence],
          mcpCapabilityGrantTokens: {
            [grantTokenKey]: 'grant:reload-failure',
          },
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
          },
          leases,
          revisionMirrorRequired: true,
        },
        rejectedSettings,
      ),
    ).rejects.toThrow('reload failed');

    expect(repo.rows).toHaveLength(3);
    expect(repo.rows[1]?.mcpCapabilityGrantTokens).toEqual({
      [grantTokenKey]: 'grant:reload-failure',
    });
    const recoveryRevision = repo.rows[2]!;
    expect(
      settingsFromRevisionDocument(recoveryRevision.settingsDocument).agents
        .main_agent.capabilities,
    ).toEqual([]);
    expect(recoveryRevision.mcpCapabilityGrantTokens).toEqual({});
    expect(recoveryRevision.note).toBe(
      'Compensate rejected MCP capability approval.',
    );

    const applySettings = vi.fn(async () => ({
      status: 'applied_no_revision' as const,
    }));
    const replay = await applySettingsRevisionWithMcpFenceRecovery({
      runtimeHome: '/tmp/gantry-import-test',
      ops: {} as never,
      repositories: {} as never,
      appId: 'default' as never,
      revision: recoveryRevision,
      revisionMirror: {
        settingsRevisions: repo,
        createdBy: 'startup:mcp-approval-recovery',
      },
      applySettings,
    });
    expect(replay.settings.agents.main_agent.capabilities).toEqual([]);
    expect(applySettings.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        agents: expect.objectContaining({
          main_agent: expect.objectContaining({ capabilities: [] }),
        }),
      }),
    );
  });

  it.each([
    {
      name: 'removes the inherited failed grant',
      successorGrantToken: 'grant:first',
      preservesGrant: false,
    },
    {
      name: 'preserves a later grant of the same capability',
      successorGrantToken: 'grant:second',
      preservesGrant: true,
    },
  ])('$name while rebasing a concurrent successor', async (scenario) => {
    capabilityErrors = [];
    applyRuntimeSettingsDesiredState.mockReset();
    addActiveMcpSourcesToRuntimeSettings.mockReset();
    const previousSettings = createDefaultRuntimeSettings();
    previousSettings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: {
        skills: [],
        mcpServers: [{ id: 'mcp:sum', tools: ['echo', 'get-sum'] }],
        tools: [],
      },
      capabilities: [],
      accessPreset: 'full',
    };
    const rejectedSettings = structuredClone(previousSettings);
    rejectedSettings.agents.main_agent.capabilities.push({
      id: 'mcp.sum.read.reviewed',
      version: 'catalog',
    });
    const grantTokenKey = mcpCapabilityGrantTokenKey(
      'main_agent',
      rejectedSettings.agents.main_agent.capabilities[0]!,
    );
    const rejectedGrantTokens = { [grantTokenKey]: 'grant:first' };
    const reviewedFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['echo', 'get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...reviewedFence,
      status: 'disabled',
    } as McpBindingAuthorityPrecondition;
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(previousSettings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
    });
    const concurrentSuccessor = structuredClone(rejectedSettings);
    concurrentSuccessor.agents.main_agent.name = 'Newer unrelated name';
    concurrentSuccessor.agents.main_agent.sources.mcpServers[0]!.tools = [
      'get-sum',
    ];
    applyRuntimeSettingsDesiredState.mockImplementationOnce(async () => {
      repo.appendConflictRevision = {
        appId: 'default',
        revision: 3,
        settingsDocument: settingsToRevisionDocument(concurrentSuccessor),
        minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
        createdBy: 'test:concurrent-writer',
        note: null,
        mcpBindingPreconditionAgentIds: ['agent:main_agent' as never],
        mcpBindingPreconditions: [reviewedFence],
        mcpCapabilityGrantTokens: {
          [grantTokenKey]: scenario.successorGrantToken,
        },
        createdAt: new Date().toISOString(),
      };
      throw new McpBindingAuthorityChangedError('mcp:sum');
    });
    addActiveMcpSourcesToRuntimeSettings.mockImplementation(
      async (input: { settings: typeof previousSettings }) => {
        input.settings.agents.main_agent.sources.mcpServers[0]!.status =
          'disabled';
        input.settings.agents.main_agent.sources.mcpServers[0]!.tools = [
          'echo',
          'get-sum',
        ];
        return [currentFence];
      },
    );

    await expect(
      importWorkstationSettings(
        {
          runtimeHome: '/tmp/gantry-import-test',
          ops: {} as never,
          repositories: {} as never,
          appId: 'default' as never,
          previousSettings,
          expectedRevision: 1,
          expectedMcpBindings: [reviewedFence],
          mcpCapabilityGrantTokens: rejectedGrantTokens,
          revisionMirror: {
            settingsRevisions: repo,
            createdBy: 'test:fleet',
          },
          leases,
          revisionMirrorRequired: true,
        },
        rejectedSettings,
      ),
    ).rejects.toThrow('changed during capability approval');

    expect(repo.rows).toHaveLength(4);
    expect(repo.rows[3]?.revision).toBe(4);
    const recovered = settingsFromRevisionDocument(
      repo.rows[3]!.settingsDocument,
    );
    expect(recovered.agents.main_agent.name).toBe('Newer unrelated name');
    expect(recovered.agents.main_agent.capabilities).toEqual(
      scenario.preservesGrant
        ? [{ id: 'mcp.sum.read.reviewed', version: 'catalog' }]
        : [],
    );
    expect(recovered.agents.main_agent.sources.mcpServers).toEqual([
      expect.objectContaining({
        id: 'mcp:sum',
        status: 'disabled',
        tools: ['get-sum'],
      }),
    ]);
    expect(repo.rows[3]?.mcpBindingPreconditions).toEqual([currentFence]);
    expect(repo.rows[3]?.mcpCapabilityGrantTokens).toEqual(
      scenario.preservesGrant
        ? { [grantTokenKey]: scenario.successorGrantToken }
        : {},
    );
    expect(repo.lastAppendExpectedRevision).toBe(3);
    expect(addActiveMcpSourcesToRuntimeSettings).toHaveBeenCalledTimes(2);
  });

  it('publishes and applies a current-authority successor for a stale boot fence', async () => {
    capabilityErrors = [];
    addActiveMcpSourcesToRuntimeSettings.mockReset();
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [{ id: 'mcp:sum' }], tools: [] },
      capabilities: [{ id: 'mcp.sum.read.reviewed', version: 'catalog' }],
      accessPreset: 'full',
    };
    const staleFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...staleFence,
      status: 'disabled',
    } as McpBindingAuthorityPrecondition;
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(settings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      expectedMcpBindings: [staleFence],
    });
    addActiveMcpSourcesToRuntimeSettings.mockImplementationOnce(
      async (input: { settings: typeof settings }) => {
        input.settings.agents.main_agent.sources.mcpServers[0]!.status =
          'disabled';
        return [currentFence];
      },
    );
    const applySettings = vi
      .fn()
      .mockRejectedValueOnce(new McpBindingAuthorityChangedError('mcp:sum'))
      .mockResolvedValueOnce({ status: 'applied_no_revision' });

    const outcome = await applySettingsRevisionWithMcpFenceRecovery({
      runtimeHome: '/tmp/gantry-import-test',
      ops: {} as never,
      repositories: {} as never,
      appId: 'default' as never,
      revision: repo.rows[0]!,
      revisionMirror: {
        settingsRevisions: repo,
        createdBy: 'startup:mcp-fence-recovery',
      },
      applySettings,
    });

    expect(outcome.revision).toBe(2);
    expect(outcome.settings.agents.main_agent.capabilities).toEqual([
      { id: 'mcp.sum.read.reviewed', version: 'catalog' },
    ]);
    expect(outcome.settings.agents.main_agent.sources.mcpServers).toEqual([
      expect.objectContaining({ id: 'mcp:sum', status: 'disabled' }),
    ]);
    expect(repo.rows[1]?.mcpBindingPreconditions).toEqual([currentFence]);
    expect(applySettings).toHaveBeenCalledTimes(2);
    expect(applySettings.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ expectedMcpBindings: [currentFence] }),
    );
  });

  it('removes an in-flight MCP grant when crash replay rejects its fence', async () => {
    capabilityErrors = [];
    addActiveMcpSourcesToRuntimeSettings.mockReset();
    const previous = createDefaultRuntimeSettings();
    previous.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [{ id: 'mcp:sum' }], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    const rejected = structuredClone(previous);
    rejected.agents.main_agent.capabilities = [
      { id: 'mcp.sum.read.reviewed', version: 'catalog' },
      { id: 'browser.use', version: 'builtin' },
    ];
    const grantTokenKey = mcpCapabilityGrantTokenKey(
      'main_agent',
      rejected.agents.main_agent.capabilities[0]!,
    );
    const staleFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...staleFence,
      status: 'disabled',
    } as McpBindingAuthorityPrecondition;
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(previous),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
    });
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(rejected),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'permission:mcp-capability',
      expectedRevision: 1,
      expectedMcpBindings: [staleFence],
      mcpCapabilityGrantTokens: { [grantTokenKey]: 'grant:crashed' },
    });
    addActiveMcpSourcesToRuntimeSettings.mockImplementationOnce(
      async (input: { settings: typeof rejected }) => {
        input.settings.agents.main_agent.sources.mcpServers[0]!.status =
          'disabled';
        return [currentFence];
      },
    );
    const applySettings = vi
      .fn()
      .mockRejectedValueOnce(new McpBindingAuthorityChangedError('mcp:sum'))
      .mockResolvedValueOnce({ status: 'applied_no_revision' });

    const outcome = await applySettingsRevisionWithMcpFenceRecovery({
      runtimeHome: '/tmp/gantry-import-test',
      ops: {} as never,
      repositories: {} as never,
      appId: 'default' as never,
      revision: repo.rows[1]!,
      revisionMirror: {
        settingsRevisions: repo,
        createdBy: 'startup:mcp-fence-recovery',
      },
      applySettings,
    });

    expect(outcome.revision).toBe(3);
    expect(outcome.settings.agents.main_agent.capabilities).toEqual([
      { id: 'browser.use', version: 'builtin' },
    ]);
    expect(repo.rows[2]?.mcpCapabilityGrantTokens).toEqual({});
    expect(repo.rows[2]?.mcpBindingPreconditions).toEqual([currentFence]);
  });

  it('consumes an equivalent recovery successor published by another worker', async () => {
    capabilityErrors = [];
    addActiveMcpSourcesToRuntimeSettings.mockReset();
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [{ id: 'mcp:sum' }], tools: [] },
      capabilities: [{ id: 'mcp.sum.read.reviewed', version: 'catalog' }],
      accessPreset: 'full',
    };
    const staleFence = {
      id: 'agent-mcp-binding:agent:main_agent:mcp:sum',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as McpBindingAuthorityPrecondition;
    const currentFence = {
      ...staleFence,
      status: 'disabled',
    } as McpBindingAuthorityPrecondition;
    const recoveredSettings = structuredClone(settings);
    recoveredSettings.agents.main_agent.sources.mcpServers[0]!.status =
      'disabled';
    const repo = new FakeRevisionRepo();
    await repo.appendSettingsRevision({
      appId: 'default',
      settingsDocument: settingsToRevisionDocument(settings),
      minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
      createdBy: 'seed',
      expectedMcpBindings: [staleFence],
    });
    addActiveMcpSourcesToRuntimeSettings.mockImplementation(
      async (input: { settings: typeof settings }) => {
        input.settings.agents.main_agent.sources.mcpServers[0]!.status =
          'disabled';
        return [currentFence];
      },
    );
    const applySettings = vi
      .fn()
      .mockImplementationOnce(async () => {
        await repo.appendSettingsRevision({
          appId: 'default',
          settingsDocument: settingsToRevisionDocument(recoveredSettings),
          minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
          createdBy: 'other-worker:mcp-fence-recovery',
          expectedRevision: 1,
          expectedMcpBindings: [currentFence],
        });
        throw new McpBindingAuthorityChangedError('mcp:sum');
      })
      .mockResolvedValueOnce({ status: 'applied_no_revision' });

    const outcome = await applySettingsRevisionWithMcpFenceRecovery({
      runtimeHome: '/tmp/gantry-import-test',
      ops: {} as never,
      repositories: {} as never,
      appId: 'default' as never,
      revision: repo.rows[0]!,
      revisionMirror: {
        settingsRevisions: repo,
        createdBy: 'startup:mcp-fence-recovery',
      },
      applySettings,
    });

    expect(outcome.revision).toBe(2);
    expect(repo.rows).toHaveLength(2);
    expect(applySettings).toHaveBeenCalledTimes(2);
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
          leases,
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
          leases,
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
      delegates: [],
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
          leases,
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
    expect(CURRENT_SETTINGS_READER_VERSION).toBe(15);
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

  it('forwards the reviewed MCP source snapshot to the revision append', async () => {
    capabilityErrors = [];
    const repo = new FakeRevisionRepo();
    const expectedBinding = {
      id: 'agent-mcp-binding:agent:test:mcp:sum',
      appId: 'default',
      agentId: 'agent:test',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z',
    } as McpBindingAuthorityPrecondition;

    const outcome = await importFleetSettingsRevision(
      baseDeps(repo),
      createDefaultRuntimeSettings(),
      { expectedRevision: 0, expectedMcpBindings: [expectedBinding] },
    );

    expect(outcome).toEqual({ status: 'applied', revision: 1 });
    expect(repo.lastAppendExpectedMcpBindings).toEqual([expectedBinding]);
  });

  it('round-trips through the typed JSON document (no YAML wrapper on the wire)', () => {
    const settings = createDefaultRuntimeSettings();
    settings.runtime.deploymentMode = 'fleet';
    settings.agent.name = 'Agent "quoted" \\ path';
    settings.agent.agentHarness = 'deepagents';
    settings.memory.llm.extractorMinConfidence = 0.73;
    settings.permissions.autoMode.model = 'sonnet';
    settings.observability.tracing = {
      enabled: true,
      endpoint: 'https://otel.example.test/v1/traces',
      captureContent: false,
      sampleRate: 0.25,
      environment: 'test',
    };
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
      delegates: [],
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
      delegates: [],
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
    settings.conversations.owner_dm = {
      providerConnection: 'telegram_main',
      providerAccount: 'telegram_main',
      externalId: '42',
      kind: 'dm',
      displayName: 'Owner DM',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['42'],
      installedAgents: {},
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
    settings.observer = {
      enabled: true,
      owner: { recipient: '42', conversation: 'owner_dm' },
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
      (document.agents as Record<string, Record<string, unknown>>).researcher,
    ).not.toHaveProperty('delegates');
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
    expect(document.observability).toEqual({
      tracing: {
        enabled: true,
        endpoint: 'https://otel.example.test/v1/traces',
        capture_content: false,
        sample_rate: 0.25,
        environment: 'test',
      },
    });
    expect(document.observer).toEqual({
      enabled: true,
      owner: { recipient: '42', conversation: 'owner_dm' },
    });
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
    expect(restored.agents.researcher.delegates).toEqual([]);
    expect(restored.permissions.autoMode).toEqual({ model: 'sonnet' });
    expect(restored.observability).toEqual(settings.observability);
    expect(restored.observer).toEqual(settings.observer);
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

  it('serializes a conversation with missing installedAgents as an empty map', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main Agent',
      folder: 'main_agent',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.providerAccounts.telegram_main = {
      agentId: 'main_agent',
      provider: 'telegram',
      label: 'Telegram Main',
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.ops = {
      providerConnection: 'telegram_main',
      providerAccount: 'telegram_main',
      externalId: '-1001234',
      kind: 'channel',
      displayName: 'Ops',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['42'],
    } as never;

    const document = settingsToRevisionDocument(settings);

    expect(
      (document.conversations as Record<string, Record<string, unknown>>).ops
        .installed_agents,
    ).toEqual({});
  });

  it('round-trips unresolved delegate folder refs through revision documents', () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.orchestrator = {
      name: 'Orchestrator',
      folder: 'orchestrator',
      delegates: ['future_researcher', 'future_analyst'],
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };

    const document = settingsToRevisionDocument(settings);

    expect(
      (document.agents as Record<string, Record<string, unknown>>).orchestrator
        .delegates,
    ).toEqual(['future_researcher', 'future_analyst']);
    expect(
      settingsFromRevisionDocument(document).agents.orchestrator.delegates,
    ).toEqual(['future_researcher', 'future_analyst']);
  });

  it('guards settings.yaml revision identity', () => {
    const settings = createDefaultRuntimeSettings();
    settings.runtime.deploymentMode = 'fleet';
    settings.agent.name = 'Revision Guard';
    settings.agents.researcher = {
      name: 'Researcher',
      folder: 'researcher',
      delegates: [],
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.providerAccounts.telegram_main = {
      agentId: 'researcher',
      provider: 'telegram',
      label: 'Telegram Main',
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
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
        researcher: {
          agentId: 'researcher',
          providerAccountId: 'telegram_main',
          status: 'active',
          addedAt: new Date(0).toISOString(),
          memoryScope: 'conversation',
        },
      },
    };

    const parsed = parseRuntimeSettings(renderRuntimeSettingsYaml(settings));
    expect(
      isDeepStrictEqual(
        settingsToRevisionDocument(parsed),
        settingsToRevisionDocument(settings),
      ),
    ).toBe(true);
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

import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import {
  mcpBindingAuthorityPrecondition,
  McpBindingAuthorityChangedError,
  type McpBindingAuthorityPrecondition,
} from '../../domain/mcp/mcp-servers.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import type { SettingsRevisionMirror } from './settings-import-service.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service.js';
import { SettingsDesiredStateService } from './desired-state-service.js';
import {
  addAgentToolRulesToRuntimeSettings,
  activateRuntimeModelAliases,
  loadRuntimeSettings,
  removeAgentToolRulesFromRuntimeSettings,
  saveRuntimeSettings,
  withRuntimeModelAliases,
} from './runtime-settings.js';
import { normalizeConfiguredCapabilitiesInSettings } from './configured-capability-normalization.js';
import { validateLoadedRuntimeSettings } from './runtime-settings-validation.js';
import { agentIdForFolder } from './desired-state-service-helpers.js';
import type {
  RuntimeConfiguredAgentSourceRef,
  RuntimeSettings,
} from './runtime-settings-types.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { mcpCapabilityGrantTokenKey } from './mcp-capability-grant-provenance.js';
import {
  capturePendingMcpSourceEdits,
  restorePendingMcpSourceEdits,
} from './mcp-source-projection-preservation.js';

const MAX_STALE_SETTINGS_RETRIES = 3;

type ProjectionSettingsOverrides = {
  providerAccount?: {
    id: string;
    runtimeSecretRefs: Record<string, string>;
  };
};

export async function applyRuntimeSettingsDesiredState(input: {
  runtimeHome: string;
  settings: RuntimeSettings;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
  previousSettings?: RuntimeSettings;
  reloadRuntimeState?: () => Promise<void>;
  expectedMcpBindingAgentIds?: AgentId[];
  expectedMcpBindings?: McpBindingAuthorityPrecondition[];
}): Promise<RuntimeSettings> {
  const expectedMcpBindingAgentIds =
    input.expectedMcpBindingAgentIds ??
    (input.expectedMcpBindings === undefined
      ? undefined
      : [
          ...new Set(
            input.expectedMcpBindings.map((binding) => binding.agentId),
          ),
        ]);
  const service = new SettingsDesiredStateService({
    ops: input.ops,
    repositories: input.repositories,
    appId: input.appId,
  });
  const normalization = await normalizeConfiguredCapabilitiesInSettings({
    settings: input.settings,
    repositories: input.repositories,
    appId: input.appId ?? ('default' as AppId),
  });
  const settings = normalization.settings;
  const reconcileSettings = normalization.changed ? input.settings : settings;
  const validation = withRuntimeModelAliases(settings, () =>
    validateLoadedRuntimeSettings(input.runtimeHome, settings),
  );
  if (!validation.ok) {
    throw new Error(
      [
        validation.failure?.summary || 'settings.yaml validation failed.',
        ...(validation.failure?.details || []),
      ].join('\n'),
    );
  }
  const rollback = async () => {
    if (!input.previousSettings) return;
    const rollbackSettings = structuredClone(input.previousSettings);
    const rollbackFence =
      (expectedMcpBindingAgentIds?.length ?? 0) > 0
        ? await snapshotConfiguredMcpBindingAuthority({
            settings: rollbackSettings,
            repositories: input.repositories,
            appId: input.appId ?? ('default' as AppId),
            additionalAgentIds: expectedMcpBindingAgentIds,
          })
        : undefined;
    applyMcpBindingSnapshotsToRuntimeSettings(rollbackSettings, rollbackFence);
    await service.reconcile(rollbackSettings, {
      expectedMcpBindingAgentIds: rollbackFence?.agentIds,
      expectedMcpBindings: rollbackFence?.bindings,
    });
    saveRuntimeSettings(input.runtimeHome, rollbackSettings);
    await input.reloadRuntimeState?.();
    activateRuntimeModelAliases(rollbackSettings);
  };
  let forwardReconcileApplied = false;
  try {
    const reconcile = await service.reconcile(reconcileSettings, {
      expectedMcpBindingAgentIds,
      expectedMcpBindings: input.expectedMcpBindings,
    });
    if (reconcile.invalidReferences.length > 0) {
      throw new Error(
        `settings desired state contains invalid references:\n${reconcile.invalidReferences.join('\n')}`,
      );
    }
    forwardReconcileApplied = true;
    saveRuntimeSettings(input.runtimeHome, settings);
    await input.reloadRuntimeState?.();
    activateRuntimeModelAliases(settings);
    return settings;
  } catch (err) {
    if (
      forwardReconcileApplied ||
      !(err instanceof McpBindingAuthorityChangedError)
    ) {
      await rollback();
    }
    throw err;
  }
}

export async function syncRuntimeSettingsFromProjection(input: {
  runtimeHome: string;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
  reloadRuntimeState?: () => Promise<void>;
  settingsRevisions?: SettingsRevisionRepository;
  pool?: SettingsRevisionMirror['pool'];
  createdBy?: string;
  overrides?: ProjectionSettingsOverrides;
}): Promise<void> {
  const service = new SettingsDesiredStateService({
    ops: input.ops,
    repositories: input.repositories,
    appId: input.appId,
  });
  for (let attempt = 0; attempt <= MAX_STALE_SETTINGS_RETRIES; attempt += 1) {
    const settings = loadRuntimeSettings(input.runtimeHome);
    const exported = await service.exportCurrent(settings);
    const providerAccountOverride = input.overrides?.providerAccount;
    if (providerAccountOverride) {
      const account = exported.providerAccounts[providerAccountOverride.id];
      if (account) {
        account.runtimeSecretRefs = providerAccountOverride.runtimeSecretRefs;
      }
    }
    if (input.settingsRevisions) {
      const appId = input.appId ?? ('default' as AppId);
      const {
        importWorkstationSettings,
        SettingsRevisionConflictError,
        SettingsStaleMutationError,
      } = await import('./settings-import-service.js');
      try {
        await importWorkstationSettings(
          {
            runtimeHome: input.runtimeHome,
            ops: input.ops,
            repositories: input.repositories,
            appId,
            previousSettings: settings,
            reloadRuntimeState: input.reloadRuntimeState,
            revisionMirror: {
              settingsRevisions: input.settingsRevisions,
              pool: input.pool,
              createdBy: input.createdBy ?? 'projection-sync',
            },
            revisionMirrorRequired: true,
          },
          exported,
        );
        return;
      } catch (err) {
        if (
          (!(err instanceof SettingsStaleMutationError) &&
            !(err instanceof SettingsRevisionConflictError)) ||
          attempt === MAX_STALE_SETTINGS_RETRIES
        ) {
          throw err;
        }
      }
      continue;
    }
    if (exported.runtime.deploymentMode === 'fleet') {
      throw new Error(
        'Fleet settings projection sync requires the settings revisions repository.',
      );
    }
    await applyRuntimeSettingsDesiredState({
      ...input,
      settings: exported,
      previousSettings: settings,
    });
    return;
  }
}

export async function addAgentToolRulesToSyncedRuntimeSettings(input: {
  runtimeHome: string;
  agentFolder: string;
  rules: readonly string[];
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
  reloadRuntimeState?: () => Promise<void>;
  settingsRevisions?: SettingsRevisionRepository;
  pool?: SettingsRevisionMirror['pool'];
  createdBy?: string;
  expectedMcpBindings?: McpBindingAuthorityPrecondition[];
  mcpCapabilityGrantToken?: string;
}): Promise<void> {
  for (let attempt = 0; attempt <= MAX_STALE_SETTINGS_RETRIES; attempt += 1) {
    const base = await loadSyncedMutationBaseSettings({
      runtimeHome: input.runtimeHome,
      settingsRevisions: input.settingsRevisions,
      appId: input.appId ?? ('default' as AppId),
    });
    const previousSettings = base.settings;
    const nextSettings = structuredClone(previousSettings);
    addAgentToolRulesToRuntimeSettings(
      nextSettings,
      input.agentFolder,
      input.rules,
    );
    const pendingMcpSourceEdits = capturePendingMcpSourceEdits({
      settings: nextSettings,
      agentIds: base.mcpBindingPreconditionAgentIds,
      bindings: base.mcpBindingPreconditions,
    });
    await addAllMcpSourcesToRuntimeSettings({
      settings: nextSettings,
      repositories: input.repositories,
      appId: input.appId ?? ('default' as AppId),
    });
    restorePendingMcpSourceEdits(nextSettings, pendingMcpSourceEdits);
    const currentMcpAuthority = await snapshotConfiguredMcpBindingAuthority({
      settings: nextSettings,
      repositories: input.repositories,
      appId: input.appId ?? ('default' as AppId),
      additionalAgentIds: [
        ...(base.mcpBindingPreconditionAgentIds ?? []),
        ...(input.expectedMcpBindings ?? []).map((binding) => binding.agentId),
      ],
    });
    const expectedMcpBindings = mergeMcpBindingPreconditions(
      currentMcpAuthority.bindings,
      input.expectedMcpBindings,
    );
    const expectedMcpBindingAgentIds = currentMcpAuthority.agentIds;
    const requestedCapabilityIds = new Set(
      input.rules
        .map(parseSemanticCapabilityRule)
        .filter((id): id is string => id !== null),
    );
    const mcpCapabilityGrantTokens = input.mcpCapabilityGrantToken
      ? Object.fromEntries(
          (nextSettings.agents[input.agentFolder]?.capabilities ?? [])
            .filter((capability) => requestedCapabilityIds.has(capability.id))
            .map((capability) => [
              mcpCapabilityGrantTokenKey(input.agentFolder, capability),
              input.mcpCapabilityGrantToken!,
            ]),
        )
      : undefined;
    if (input.settingsRevisions) {
      const appId = input.appId ?? ('default' as AppId);
      const {
        importWorkstationSettings,
        SettingsRevisionConflictError,
        SettingsStaleMutationError,
      } = await import('./settings-import-service.js');
      try {
        await importWorkstationSettings(
          {
            runtimeHome: input.runtimeHome,
            ops: input.ops,
            repositories: input.repositories,
            appId,
            previousSettings,
            reloadRuntimeState: input.reloadRuntimeState,
            revisionMirror: {
              settingsRevisions: input.settingsRevisions,
              pool: input.pool,
              createdBy: input.createdBy ?? 'permission:persistent-tool-rule',
            },
            revisionMirrorRequired: true,
            expectedRevision: base.expectedRevision,
            expectedMcpBindingAgentIds,
            expectedMcpBindings,
            mcpCapabilityGrantTokens,
          },
          nextSettings,
        );
        return;
      } catch (err) {
        if (
          (!(err instanceof SettingsStaleMutationError) &&
            !(err instanceof SettingsRevisionConflictError)) ||
          attempt === MAX_STALE_SETTINGS_RETRIES
        ) {
          throw err;
        }
      }
      continue;
    }
    if (nextSettings.runtime.deploymentMode === 'fleet') {
      throw new Error(
        'Fleet tool-rule settings mutation requires the settings revisions repository.',
      );
    }
    await applyRuntimeSettingsDesiredState({
      runtimeHome: input.runtimeHome,
      settings: nextSettings,
      previousSettings,
      ops: input.ops,
      repositories: input.repositories,
      appId: input.appId,
      reloadRuntimeState: input.reloadRuntimeState,
      expectedMcpBindingAgentIds,
      expectedMcpBindings,
    });
    return;
  }
}
export async function addActiveMcpSourcesToRuntimeSettings(input: {
  settings: RuntimeSettings;
  agentFolder: string;
  repositories: Pick<SettingsDesiredStateRepositories, 'mcpServers'>;
  appId: AppId;
}): Promise<McpBindingAuthorityPrecondition[]> {
  const folder = input.agentFolder.trim();
  const agent = input.settings.agents[folder];
  if (!agent) return [];
  const bindings = await input.repositories.mcpServers.listAgentBindings({
    appId: input.appId,
    agentId: agentIdForFolder(folder),
  });
  const existing = new Map(
    agent.sources.mcpServers.map((source) => [source.id, source]),
  );
  const next: RuntimeConfiguredAgentSourceRef[] = [...agent.sources.mcpServers];
  for (const binding of bindings) {
    const id = String(binding.serverId);
    const existingSource = existing.get(id);
    if (existingSource) {
      existingSource.status = binding.status;
      setExactMcpSourceTools(existingSource, binding.allowedToolPatterns);
      continue;
    }
    if (binding.status !== 'active') continue;
    existing.set(id, { id });
    next.push({
      id,
      ...(binding.allowedToolPatterns.length > 0
        ? { tools: binding.allowedToolPatterns }
        : {}),
    });
  }
  agent.sources.mcpServers = next.sort((a, b) => a.id.localeCompare(b.id));
  return bindings.map(mcpBindingAuthorityPrecondition);
}

export async function addAllMcpSourcesToRuntimeSettings(input: {
  settings: RuntimeSettings;
  repositories: Pick<SettingsDesiredStateRepositories, 'mcpServers'>;
  appId: AppId;
}): Promise<McpBindingAuthorityPrecondition[]> {
  const snapshots: McpBindingAuthorityPrecondition[] = [];
  for (const agentFolder of Object.keys(input.settings.agents).sort()) {
    snapshots.push(
      ...(await addActiveMcpSourcesToRuntimeSettings({
        ...input,
        agentFolder,
      })),
    );
  }
  return snapshots;
}

export function configuredMcpBindingAgentIds(
  settings: RuntimeSettings,
): AgentId[] {
  return Object.keys(settings.agents).sort().map(agentIdForFolder);
}

export async function snapshotConfiguredMcpBindingAuthority(input: {
  settings: RuntimeSettings;
  repositories: Pick<SettingsDesiredStateRepositories, 'mcpServers'>;
  appId: AppId;
  additionalAgentIds?: readonly AgentId[];
}): Promise<{
  agentIds: AgentId[];
  bindings: McpBindingAuthorityPrecondition[];
}> {
  const agentIds = [
    ...new Set([
      ...configuredMcpBindingAgentIds(input.settings),
      ...(input.additionalAgentIds ?? []),
    ]),
  ].sort();
  const bindings: McpBindingAuthorityPrecondition[] = [];
  for (const agentId of agentIds) {
    bindings.push(
      ...(
        await input.repositories.mcpServers.listAgentBindings({
          appId: input.appId,
          agentId,
        })
      ).map(mcpBindingAuthorityPrecondition),
    );
  }
  return { agentIds, bindings };
}

function mergeMcpBindingPreconditions(
  projected: readonly McpBindingAuthorityPrecondition[],
  reviewed: readonly McpBindingAuthorityPrecondition[] | undefined,
): McpBindingAuthorityPrecondition[] {
  const byId = new Map(projected.map((binding) => [binding.id, binding]));
  for (const binding of reviewed ?? []) byId.set(binding.id, binding);
  return [...byId.values()];
}

function applyMcpBindingSnapshotsToRuntimeSettings(
  settings: RuntimeSettings,
  snapshot:
    | {
        agentIds: readonly AgentId[];
        bindings: readonly McpBindingAuthorityPrecondition[];
      }
    | undefined,
): void {
  if (!snapshot) return;
  const fencedAgentIds = new Set(snapshot.agentIds);
  const bindingsByAgent = new Map<AgentId, McpBindingAuthorityPrecondition[]>();
  for (const binding of snapshot.bindings) {
    const bindings = bindingsByAgent.get(binding.agentId) ?? [];
    bindings.push(binding);
    bindingsByAgent.set(binding.agentId, bindings);
  }
  for (const [folder, configuredAgent] of Object.entries(settings.agents)) {
    const agentId = agentIdForFolder(folder);
    if (!fencedAgentIds.has(agentId)) continue;
    const currentBindings = bindingsByAgent.get(agentId) ?? [];
    const currentByServerId = new Map(
      currentBindings.map((binding) => [String(binding.serverId), binding]),
    );
    const existingByServerId = new Map(
      configuredAgent.sources.mcpServers.map((source) => [source.id, source]),
    );
    for (const source of configuredAgent.sources.mcpServers) {
      const binding = currentByServerId.get(source.id);
      if (!binding) {
        source.status = 'disabled';
        continue;
      }
      source.status = binding.status;
      setExactMcpSourceTools(source, binding.allowedToolPatterns);
    }
    for (const binding of currentBindings) {
      if (
        binding.status !== 'active' ||
        existingByServerId.has(String(binding.serverId))
      ) {
        continue;
      }
      configuredAgent.sources.mcpServers.push({
        id: String(binding.serverId),
        status: 'active',
        ...(binding.allowedToolPatterns.length > 0
          ? { tools: [...binding.allowedToolPatterns] }
          : {}),
      });
    }
    configuredAgent.sources.mcpServers.sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }
}

function setExactMcpSourceTools(
  source: RuntimeConfiguredAgentSourceRef,
  allowedToolPatterns: readonly string[],
): void {
  if (allowedToolPatterns.length > 0) {
    source.tools = [...allowedToolPatterns];
    return;
  }
  delete source.tools;
}

export async function removeAgentToolRulesFromSyncedRuntimeSettings(input: {
  runtimeHome: string;
  agentFolder: string;
  rules: readonly string[];
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
  reloadRuntimeState?: () => Promise<void>;
  settingsRevisions?: SettingsRevisionRepository;
  pool?: SettingsRevisionMirror['pool'];
  createdBy?: string;
}): Promise<void> {
  const base = await loadSyncedMutationBaseSettings({
    runtimeHome: input.runtimeHome,
    settingsRevisions: input.settingsRevisions,
    appId: input.appId ?? ('default' as AppId),
  });
  const previousSettings = base.settings;
  const nextSettings = structuredClone(previousSettings);
  removeAgentToolRulesFromRuntimeSettings(
    nextSettings,
    input.agentFolder,
    input.rules,
  );
  const pendingMcpSourceEdits = capturePendingMcpSourceEdits({
    settings: nextSettings,
    agentIds: base.mcpBindingPreconditionAgentIds,
    bindings: base.mcpBindingPreconditions,
  });
  await addAllMcpSourcesToRuntimeSettings({
    settings: nextSettings,
    repositories: input.repositories,
    appId: input.appId ?? ('default' as AppId),
  });
  restorePendingMcpSourceEdits(nextSettings, pendingMcpSourceEdits);
  const currentMcpAuthority = await snapshotConfiguredMcpBindingAuthority({
    settings: nextSettings,
    repositories: input.repositories,
    appId: input.appId ?? ('default' as AppId),
    additionalAgentIds: base.mcpBindingPreconditionAgentIds,
  });
  const expectedMcpBindings = currentMcpAuthority.bindings;
  const expectedMcpBindingAgentIds = currentMcpAuthority.agentIds;
  if (input.settingsRevisions) {
    const appId = input.appId ?? ('default' as AppId);
    const { importWorkstationSettings } =
      await import('./settings-import-service.js');
    await importWorkstationSettings(
      {
        runtimeHome: input.runtimeHome,
        ops: input.ops,
        repositories: input.repositories,
        appId,
        previousSettings,
        reloadRuntimeState: input.reloadRuntimeState,
        revisionMirror: {
          settingsRevisions: input.settingsRevisions,
          pool: input.pool,
          createdBy: input.createdBy ?? 'permission:persistent-tool-rule',
        },
        revisionMirrorRequired: true,
        expectedRevision: base.expectedRevision,
        expectedMcpBindingAgentIds,
        expectedMcpBindings,
      },
      nextSettings,
    );
    return;
  }
  if (nextSettings.runtime.deploymentMode === 'fleet') {
    throw new Error(
      'Fleet tool-rule settings mutation requires the settings revisions repository.',
    );
  }
  await applyRuntimeSettingsDesiredState({
    runtimeHome: input.runtimeHome,
    settings: nextSettings,
    previousSettings,
    ops: input.ops,
    repositories: input.repositories,
    appId: input.appId,
    reloadRuntimeState: input.reloadRuntimeState,
    expectedMcpBindingAgentIds,
    expectedMcpBindings,
  });
}

async function loadSyncedMutationBaseSettings(input: {
  runtimeHome: string;
  settingsRevisions?: SettingsRevisionRepository;
  appId: AppId;
}): Promise<{
  settings: RuntimeSettings;
  expectedRevision?: number;
  mcpBindingPreconditionAgentIds?: AgentId[];
  mcpBindingPreconditions?: McpBindingAuthorityPrecondition[];
}> {
  if (!input.settingsRevisions) {
    return { settings: loadRuntimeSettings(input.runtimeHome) };
  }
  const latest = await input.settingsRevisions.getLatestSettingsRevision(
    input.appId,
  );
  if (!latest) {
    return { settings: loadRuntimeSettings(input.runtimeHome) };
  }
  const { settingsFromRevisionDocument } =
    await import('./settings-import-service.js');
  return {
    settings: settingsFromRevisionDocument(latest.settingsDocument),
    expectedRevision: latest.revision,
    mcpBindingPreconditionAgentIds: latest.mcpBindingPreconditionAgentIds,
    mcpBindingPreconditions: latest.mcpBindingPreconditions,
  };
}

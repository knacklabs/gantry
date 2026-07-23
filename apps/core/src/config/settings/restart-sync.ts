import type { AppId } from '../../domain/app/app.js';
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
}): Promise<RuntimeSettings> {
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
    saveRuntimeSettings(input.runtimeHome, input.previousSettings);
    await service.reconcile(input.previousSettings);
    await input.reloadRuntimeState?.();
    activateRuntimeModelAliases(input.previousSettings);
  };
  try {
    saveRuntimeSettings(input.runtimeHome, settings);
    const reconcile = await service.reconcile(reconcileSettings);
    if (reconcile.invalidReferences.length > 0) {
      throw new Error(
        `settings desired state contains invalid references:\n${reconcile.invalidReferences.join('\n')}`,
      );
    }
    await input.reloadRuntimeState?.();
    activateRuntimeModelAliases(settings);
    return settings;
  } catch (err) {
    await rollback();
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
    await addActiveMcpSourcesToRuntimeSettings({
      settings: nextSettings,
      agentFolder: input.agentFolder,
      repositories: input.repositories,
      appId: input.appId ?? ('default' as AppId),
    });
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
    });
    return;
  }
}
export async function addActiveMcpSourcesToRuntimeSettings(input: {
  settings: RuntimeSettings;
  agentFolder: string;
  repositories: Pick<SettingsDesiredStateRepositories, 'mcpServers'>;
  appId: AppId;
}): Promise<void> {
  const folder = input.agentFolder.trim();
  const agent = input.settings.agents[folder];
  if (!agent) return;
  const bindings = await input.repositories.mcpServers.listAgentBindings({
    appId: input.appId,
    agentId: agentIdForFolder(folder),
    limit: 500,
  });
  const existing = new Map(
    agent.sources.mcpServers.map((source) => [source.id, source]),
  );
  const next: RuntimeConfiguredAgentSourceRef[] = [...agent.sources.mcpServers];
  for (const binding of bindings) {
    if (binding.status !== 'active') continue;
    const id = String(binding.serverId);
    const existingSource = existing.get(id);
    if (existingSource) {
      if (
        existingSource.tools?.length &&
        binding.allowedToolPatterns.length > 0
      ) {
        existingSource.tools = [
          ...new Set([...existingSource.tools, ...binding.allowedToolPatterns]),
        ];
      }
      continue;
    }
    existing.set(id, { id });
    next.push({
      id,
      ...(binding.allowedToolPatterns.length > 0
        ? { tools: binding.allowedToolPatterns }
        : {}),
    });
  }
  agent.sources.mcpServers = next.sort((a, b) => a.id.localeCompare(b.id));
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
  });
}

async function loadSyncedMutationBaseSettings(input: {
  runtimeHome: string;
  settingsRevisions?: SettingsRevisionRepository;
  appId: AppId;
}): Promise<{ settings: RuntimeSettings; expectedRevision?: number }> {
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
  };
}

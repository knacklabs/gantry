import type { AppId } from '../../domain/app/app.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service.js';
import { SettingsDesiredStateService } from './desired-state-service.js';
import {
  addAgentToolRulesToRuntimeSettings,
  loadRuntimeSettings,
  removeAgentToolRulesFromRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';
import { normalizeConfiguredCapabilitiesInSettings } from './configured-capability-normalization.js';
import { validateLoadedRuntimeSettings } from './runtime-settings-validation.js';
import { agentIdForFolder } from './desired-state-service-helpers.js';
import type {
  RuntimeConfiguredAgentSourceRef,
  RuntimeSettings,
} from './runtime-settings-types.js';

export async function applyRuntimeSettingsDesiredState(input: {
  runtimeHome: string;
  settings: RuntimeSettings;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
  previousSettings?: RuntimeSettings;
  reloadRuntimeState?: () => Promise<void>;
}): Promise<void> {
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
  const validation = validateLoadedRuntimeSettings(input.runtimeHome, settings);
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
}): Promise<void> {
  const settings = loadRuntimeSettings(input.runtimeHome);
  const service = new SettingsDesiredStateService({
    ops: input.ops,
    repositories: input.repositories,
    appId: input.appId,
  });
  await applyRuntimeSettingsDesiredState({
    ...input,
    settings: await service.exportCurrent(settings),
    previousSettings: settings,
  });
}

export async function addAgentToolRulesToSyncedRuntimeSettings(input: {
  runtimeHome: string;
  agentFolder: string;
  rules: readonly string[];
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
  reloadRuntimeState?: () => Promise<void>;
}): Promise<void> {
  const previousSettings = loadRuntimeSettings(input.runtimeHome);
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
}): Promise<void> {
  const previousSettings = loadRuntimeSettings(input.runtimeHome);
  const nextSettings = structuredClone(previousSettings);
  removeAgentToolRulesFromRuntimeSettings(
    nextSettings,
    input.agentFolder,
    input.rules,
  );
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

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
import type { RuntimeSettings } from './runtime-settings-types.js';

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

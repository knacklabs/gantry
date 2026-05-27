import fs from 'fs';

import { guardrailPolicySettingsValidator } from '../application/guardrails/policy-registry.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { RuntimeApp } from '../app/bootstrap/runtime-app.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import { validateLoadedRuntimeSettings } from '../config/settings/runtime-settings-validation.js';
import { settingsFilePath } from '../config/settings/runtime-home.js';
import {
  classifySettingsChanges,
  SettingsDesiredStateService,
  type SettingsDesiredStateRepositories,
  type SettingsDesiredStateOps,
} from '../config/settings/desired-state-service.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings-types.js';
import { invalidateSenderAllowlistCache } from '../platform/sender-allowlist.js';

export interface SettingsReloadWatcherOptions {
  runtimeHome: string;
  app: RuntimeApp;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  pollIntervalMs?: number;
}

export interface SettingsReloadWatcher {
  close(): void;
}

export function startSettingsReloadWatcher(
  options: SettingsReloadWatcherOptions,
): SettingsReloadWatcher {
  const filePath = settingsFilePath(options.runtimeHome);
  let lastGoodSettings: RuntimeSettings | undefined;
  let reloadInFlight: Promise<void> | undefined;
  let reloadQueued = false;

  try {
    lastGoodSettings = loadRuntimeSettings(options.runtimeHome);
  } catch (err) {
    logger.warn(
      { err, filePath },
      'Initial settings snapshot unavailable for reload watcher',
    );
  }

  const reload = async () => {
    if (reloadInFlight) {
      reloadQueued = true;
      return reloadInFlight;
    }
    reloadInFlight = (async () => {
      let settings: RuntimeSettings;
      try {
        settings = loadRuntimeSettings(options.runtimeHome);
      } catch (err) {
        logger.warn(
          { err, filePath },
          'settings.yaml reload failed; keeping last good settings',
        );
        return;
      }

      const validation = validateLoadedRuntimeSettings(
        options.runtimeHome,
        settings,
      );
      if (!validation.ok) {
        logger.warn(
          { filePath, details: validation.failure?.details ?? [] },
          'settings.yaml reload validation failed; keeping last good settings',
        );
        return;
      }

      const service = new SettingsDesiredStateService({
        ops: options.ops,
        repositories: options.repositories,
        guardrailPolicies: guardrailPolicySettingsValidator(),
      });
      const reconcile = await service.reconcile(settings);
      if (reconcile.invalidReferences.length > 0) {
        logger.warn(
          { filePath, invalidReferences: reconcile.invalidReferences },
          'settings.yaml reload contains unavailable references; keeping last good settings',
        );
        return;
      }

      const classification = lastGoodSettings
        ? classifySettingsChanges(lastGoodSettings, settings)
        : { liveApplied: ['settings'], restartRequired: [] };
      lastGoodSettings = settings;
      invalidateSenderAllowlistCache(filePath);
      // Re-snapshot provider + agent settings so the routing layer
      // (channel-persistence-handlers.ensureInteraktDirectRoute) reads the
      // latest providers.<id>.default_agent and agent display names after a
      // hot reload — otherwise it would silently keep using stale values.
      options.app.setProviderSettings(settings.providers);
      options.app.setAgentsSettings(settings.agents);
      await options.app.loadState();
      logger.info(
        {
          filePath,
          applied: reconcile.applied.length,
          skipped: reconcile.skipped.length,
          liveApplied: classification.liveApplied,
          restartRequired: classification.restartRequired,
        },
        'settings.yaml reload reconciled',
      );
    })().finally(() => {
      reloadInFlight = undefined;
      if (reloadQueued) {
        reloadQueued = false;
        void reload().catch((err) =>
          logger.warn({ err, filePath }, 'queued settings.yaml reload failed'),
        );
      }
    });
    return reloadInFlight;
  };

  fs.watchFile(
    filePath,
    { interval: options.pollIntervalMs ?? 5000 },
    (current, previous) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size
      ) {
        return;
      }
      void reload().catch((err) =>
        logger.warn({ err, filePath }, 'settings.yaml reload failed'),
      );
    },
  );

  return {
    close: () => {
      fs.unwatchFile(filePath);
    },
  };
}

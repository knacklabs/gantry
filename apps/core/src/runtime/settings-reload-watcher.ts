import fs from 'fs';

import { logger } from '../infrastructure/logging/logger.js';
import type { RuntimeApp } from '../app/bootstrap/runtime-app.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import { settingsFilePath } from '../config/settings/runtime-home.js';
import {
  classifySettingsChanges,
  type SettingsDesiredStateRepositories,
  type SettingsDesiredStateOps,
} from '../config/settings/desired-state-service.js';
import {
  importWorkstationSettings,
  settingsToRevisionDocument,
  type SettingsRevisionMirror,
} from '../config/settings/settings-import-service.js';
import { invalidateSenderAllowlistCache } from '../platform/sender-allowlist.js';
import type { AppId } from '../domain/app/app.js';
import type { SettingsRevisionRepository } from '../domain/ports/fleet-capability-state.js';

export interface SettingsReloadWatcherOptions {
  runtimeHome: string;
  app: RuntimeApp;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
  settingsRevisions?: SettingsRevisionRepository;
  settingsRevisionPool?: SettingsRevisionMirror['pool'];
  pollIntervalMs?: number;
}

export interface SettingsReloadWatcher {
  close(): void;
}

export function startSettingsReloadWatcher(
  options: SettingsReloadWatcherOptions,
): SettingsReloadWatcher {
  const filePath = settingsFilePath(options.runtimeHome);
  let lastGoodSettings: ReturnType<typeof loadRuntimeSettings> | undefined;
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
      let settings: ReturnType<typeof loadRuntimeSettings>;
      try {
        settings = loadRuntimeSettings(options.runtimeHome);
      } catch (err) {
        logger.warn(
          { err, filePath },
          'settings.yaml reload failed; keeping last good settings',
        );
        return;
      }

      if (
        lastGoodSettings &&
        settingsDocumentsMatch(settings, lastGoodSettings)
      ) {
        logger.info(
          { filePath },
          'settings.yaml reload matched last good settings; no reload needed',
        );
        return;
      }

      let matchesLatestRevision = false;
      if (options.settingsRevisions) {
        try {
          matchesLatestRevision = await settingsMatchesLatestRevision({
            appId: options.appId ?? ('default' as AppId),
            settings,
            settingsRevisions: options.settingsRevisions,
          });
        } catch (err) {
          logger.warn(
            { err, filePath },
            'settings revision lookup failed; continuing with local settings.yaml reload',
          );
        }
      }

      // The watcher is the workstation auto-importer: route validation, write,
      // and reconcile through the single shared import path used by the CLI and
      // control API (ADR-3: one mutation path, no authority fork).
      try {
        await importWorkstationSettings(
          {
            runtimeHome: options.runtimeHome,
            ops: options.ops,
            repositories: options.repositories,
            appId: options.appId,
            previousSettings: lastGoodSettings,
            reloadRuntimeState: () => options.app.loadState(),
            revisionMirror:
              options.settingsRevisions && !matchesLatestRevision
                ? {
                    settingsRevisions: options.settingsRevisions,
                    pool: options.settingsRevisionPool,
                    createdBy: 'settings.yaml:auto-import',
                    logWarn: (context, message) =>
                      logger.warn(context, message),
                  }
                : undefined,
          },
          settings,
        );
      } catch (err) {
        logger.warn(
          { err, filePath },
          'settings.yaml reload failed validation/reconcile; keeping last good settings',
        );
        return;
      }

      const reloaded = loadRuntimeSettings(options.runtimeHome);
      const classification = lastGoodSettings
        ? classifySettingsChanges(lastGoodSettings, reloaded)
        : { liveApplied: ['settings'], restartRequired: [] };
      lastGoodSettings = reloaded;
      invalidateSenderAllowlistCache(filePath);
      logger.info(
        {
          filePath,
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

async function settingsMatchesLatestRevision(input: {
  appId: AppId;
  settings: ReturnType<typeof loadRuntimeSettings>;
  settingsRevisions: SettingsRevisionRepository;
}): Promise<boolean> {
  const latest = await input.settingsRevisions.getLatestSettingsRevision(
    input.appId,
  );
  if (!latest) return false;
  return (
    stableJson(latest.settingsDocument) ===
    stableJson(settingsToRevisionDocument(input.settings))
  );
}

function settingsDocumentsMatch(
  left: ReturnType<typeof loadRuntimeSettings>,
  right: ReturnType<typeof loadRuntimeSettings>,
): boolean {
  return (
    stableJson(settingsToRevisionDocument(left)) ===
    stableJson(settingsToRevisionDocument(right))
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

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
  applySettingsRevisionWithMcpFenceRecovery,
  importWorkstationSettings,
  settingsFromRevisionDocument,
  SettingsRevisionConflictError,
  SettingsStaleMutationError,
  settingsToRevisionDocument,
  stableJson,
  type SettingsRevisionMirror,
} from '../config/settings/settings-import-service.js';
import {
  addAllMcpSourcesToRuntimeSettings,
  snapshotConfiguredMcpBindingAuthority,
} from '../config/settings/restart-sync.js';
import {
  capturePendingMcpSourceEdits,
  restorePendingMcpSourceEdits,
} from '../config/settings/mcp-source-projection-preservation.js';
import { invalidateSenderAllowlistCache } from '../platform/sender-allowlist.js';
import type { AppId } from '../domain/app/app.js';
import type { AgentId } from '../domain/agent/agent.js';
import {
  McpBindingAuthorityChangedError,
  type McpBindingAuthorityPrecondition,
} from '../domain/mcp/mcp-servers.js';
import type {
  SettingsRevision,
  SettingsRevisionRepository,
} from '../domain/ports/fleet-capability-state.js';

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
  let retryTimer: NodeJS.Timeout | undefined;

  try {
    lastGoodSettings = loadRuntimeSettings(options.runtimeHome);
  } catch (err) {
    logger.warn(
      { err, filePath },
      'Initial settings snapshot unavailable for reload watcher',
    );
  }

  const scheduleReloadRetry = () => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void reload().catch((err) =>
        logger.warn({ err, filePath }, 'retried settings.yaml reload failed'),
      );
    }, options.pollIntervalMs ?? 5000);
    retryTimer.unref?.();
  };

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
      let latestRevision = 0;
      let latestSettingsRevision: SettingsRevision | undefined;
      let latestMcpBindingPreconditions:
        | McpBindingAuthorityPrecondition[]
        | undefined;
      let latestMcpBindingPreconditionAgentIds: AgentId[] | undefined;
      if (options.settingsRevisions) {
        try {
          const latest =
            await options.settingsRevisions.getLatestSettingsRevision(
              options.appId ?? ('default' as AppId),
            );
          latestSettingsRevision = latest ?? undefined;
          latestRevision = latest?.revision ?? 0;
          latestMcpBindingPreconditionAgentIds =
            latest?.mcpBindingPreconditionAgentIds;
          latestMcpBindingPreconditions = latest?.mcpBindingPreconditions;
          matchesLatestRevision = latest
            ? stableJson(latest.settingsDocument) ===
              stableJson(settingsToRevisionDocument(settings))
            : false;
        } catch (err) {
          logger.warn(
            { err, filePath },
            'settings revision lookup failed; keeping last good settings',
          );
          scheduleReloadRetry();
          return;
        }
      }

      // The watcher is the workstation auto-importer: route validation, write,
      // and reconcile through the single shared import path used by the CLI and
      // control API (ADR-3: one mutation path, no authority fork).
      try {
        let settingsToImport = settings;
        let previousSettingsForImport = lastGoodSettings;
        if (
          !matchesLatestRevision &&
          latestSettingsRevision &&
          lastGoodSettings
        ) {
          const latestSettings = settingsFromRevisionDocument(
            latestSettingsRevision.settingsDocument,
          );
          settingsToImport = rebasePendingSettingsEdits({
            base: lastGoodSettings,
            edited: settings,
            current: latestSettings,
          });
          previousSettingsForImport = latestSettings;

          if ((latestMcpBindingPreconditionAgentIds?.length ?? 0) > 0) {
            const pendingMcpSourceEdits = capturePendingMcpSourceEdits({
              settings: settingsToImport,
              agentIds: latestMcpBindingPreconditionAgentIds,
              bindings: latestMcpBindingPreconditions,
            });
            await addAllMcpSourcesToRuntimeSettings({
              settings: settingsToImport,
              repositories: options.repositories,
              appId: options.appId ?? ('default' as AppId),
            });
            restorePendingMcpSourceEdits(
              settingsToImport,
              pendingMcpSourceEdits,
            );
            const currentMcpAuthority =
              await snapshotConfiguredMcpBindingAuthority({
                settings: settingsToImport,
                repositories: options.repositories,
                appId: options.appId ?? ('default' as AppId),
                additionalAgentIds: latestMcpBindingPreconditionAgentIds,
              });
            latestMcpBindingPreconditionAgentIds = currentMcpAuthority.agentIds;
            latestMcpBindingPreconditions = currentMcpAuthority.bindings;
          }
        }
        const revisionMirror = options.settingsRevisions
          ? {
              settingsRevisions: options.settingsRevisions,
              pool: options.settingsRevisionPool,
              createdBy: matchesLatestRevision
                ? 'settings.yaml:mcp-fence-recovery'
                : 'settings.yaml:auto-import',
              logWarn: (context: Record<string, unknown>, message: string) =>
                logger.warn(context, message),
            }
          : undefined;
        if (matchesLatestRevision && latestSettingsRevision && revisionMirror) {
          await applySettingsRevisionWithMcpFenceRecovery({
            runtimeHome: options.runtimeHome,
            ops: options.ops,
            repositories: options.repositories,
            appId: options.appId ?? ('default' as AppId),
            revision: latestSettingsRevision,
            reloadRuntimeState: () => options.app.loadState(),
            revisionMirror,
          });
        } else {
          await importWorkstationSettings(
            {
              runtimeHome: options.runtimeHome,
              ops: options.ops,
              repositories: options.repositories,
              appId: options.appId,
              previousSettings: previousSettingsForImport,
              reloadRuntimeState: () => options.app.loadState(),
              revisionMirror,
              revisionMirrorRequired: options.settingsRevisions !== undefined,
              expectedRevision: latestRevision,
              expectedMcpBindingAgentIds: latestMcpBindingPreconditionAgentIds,
              expectedMcpBindings: latestMcpBindingPreconditions,
            },
            settingsToImport,
          );
        }
      } catch (err) {
        logger.warn(
          { err, filePath },
          'settings.yaml reload failed validation/reconcile; keeping last good settings',
        );
        if (
          err instanceof SettingsRevisionConflictError ||
          err instanceof SettingsStaleMutationError ||
          err instanceof McpBindingAuthorityChangedError
        ) {
          scheduleReloadRetry();
        }
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
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      void reload().catch((err) =>
        logger.warn({ err, filePath }, 'settings.yaml reload failed'),
      );
    },
  );

  return {
    close: () => {
      if (retryTimer) clearTimeout(retryTimer);
      fs.unwatchFile(filePath);
    },
  };
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

function rebasePendingSettingsEdits(input: {
  base: ReturnType<typeof loadRuntimeSettings>;
  edited: ReturnType<typeof loadRuntimeSettings>;
  current: ReturnType<typeof loadRuntimeSettings>;
}): ReturnType<typeof loadRuntimeSettings> {
  const rebased = rebaseJsonEdits(
    settingsToRevisionDocument(input.base),
    settingsToRevisionDocument(input.edited),
    settingsToRevisionDocument(input.current),
  );
  return settingsFromRevisionDocument(rebased as Record<string, unknown>);
}

function rebaseJsonEdits(
  base: unknown,
  edited: unknown,
  current: unknown,
  path: string[] = [],
): unknown {
  if (stableJson(base) === stableJson(edited)) return structuredClone(current);
  if (
    !isPlainRecord(base) ||
    !isPlainRecord(edited) ||
    !isPlainRecord(current)
  ) {
    if (
      stableJson(base) !== stableJson(current) &&
      stableJson(edited) !== stableJson(current)
    ) {
      throw settingsRebaseConflict(path);
    }
    return structuredClone(edited);
  }

  const rebased = structuredClone(current);
  for (const key of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    if (!(key in edited)) {
      if (
        key in current &&
        stableJson(base[key]) !== stableJson(current[key])
      ) {
        throw settingsRebaseConflict([...path, key]);
      }
      delete rebased[key];
      continue;
    }
    if (!(key in base)) {
      if (
        key in current &&
        stableJson(edited[key]) !== stableJson(current[key])
      ) {
        throw settingsRebaseConflict([...path, key]);
      }
      rebased[key] = structuredClone(edited[key]);
      continue;
    }
    if (stableJson(base[key]) === stableJson(edited[key])) continue;
    rebased[key] = rebaseJsonEdits(base[key], edited[key], rebased[key], [
      ...path,
      key,
    ]);
  }
  return rebased;
}

function settingsRebaseConflict(path: readonly string[]): Error {
  return new Error(
    `settings.yaml edit conflicts with a newer settings revision at ${path.join('.') || '<root>'}; reload the current settings and retry the edit.`,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

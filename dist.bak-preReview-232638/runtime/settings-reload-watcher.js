import fs from 'fs';
import { logger } from '../infrastructure/logging/logger.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import { settingsFilePath } from '../config/settings/runtime-home.js';
import { classifySettingsChanges, } from '../config/settings/desired-state-service.js';
import { importWorkstationSettings, settingsToRevisionDocument, stableJson, } from '../config/settings/settings-import-service.js';
import { invalidateSenderAllowlistCache } from '../platform/sender-allowlist.js';
export function startSettingsReloadWatcher(options) {
    const filePath = settingsFilePath(options.runtimeHome);
    let lastGoodSettings;
    let reloadInFlight;
    let reloadQueued = false;
    let retryTimer;
    try {
        lastGoodSettings = loadRuntimeSettings(options.runtimeHome);
    }
    catch (err) {
        logger.warn({ err, filePath }, 'Initial settings snapshot unavailable for reload watcher');
    }
    const scheduleReloadRetry = () => {
        if (retryTimer)
            return;
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void reload().catch((err) => logger.warn({ err, filePath }, 'retried settings.yaml reload failed'));
        }, options.pollIntervalMs ?? 5000);
        retryTimer.unref?.();
    };
    const reload = async () => {
        if (reloadInFlight) {
            reloadQueued = true;
            return reloadInFlight;
        }
        reloadInFlight = (async () => {
            let settings;
            try {
                settings = loadRuntimeSettings(options.runtimeHome);
            }
            catch (err) {
                logger.warn({ err, filePath }, 'settings.yaml reload failed; keeping last good settings');
                return;
            }
            if (lastGoodSettings &&
                settingsDocumentsMatch(settings, lastGoodSettings)) {
                logger.info({ filePath }, 'settings.yaml reload matched last good settings; no reload needed');
                return;
            }
            let matchesLatestRevision = false;
            let latestRevision = 0;
            if (options.settingsRevisions) {
                try {
                    const latest = await options.settingsRevisions.getLatestSettingsRevision(options.appId ?? 'default');
                    latestRevision = latest?.revision ?? 0;
                    matchesLatestRevision = latest
                        ? stableJson(latest.settingsDocument) ===
                            stableJson(settingsToRevisionDocument(settings))
                        : false;
                }
                catch (err) {
                    logger.warn({ err, filePath }, 'settings revision lookup failed; keeping last good settings');
                    scheduleReloadRetry();
                    return;
                }
            }
            // The watcher is the workstation auto-importer: route validation, write,
            // and reconcile through the single shared import path used by the CLI and
            // control API (ADR-3: one mutation path, no authority fork).
            try {
                await importWorkstationSettings({
                    runtimeHome: options.runtimeHome,
                    ops: options.ops,
                    repositories: options.repositories,
                    appId: options.appId,
                    previousSettings: lastGoodSettings,
                    reloadRuntimeState: () => options.app.loadState(),
                    revisionMirror: options.settingsRevisions && !matchesLatestRevision
                        ? {
                            settingsRevisions: options.settingsRevisions,
                            pool: options.settingsRevisionPool,
                            createdBy: 'settings.yaml:auto-import',
                            logWarn: (context, message) => logger.warn(context, message),
                        }
                        : undefined,
                    revisionMirrorRequired: options.settingsRevisions !== undefined && !matchesLatestRevision,
                    expectedRevision: !matchesLatestRevision
                        ? latestRevision
                        : undefined,
                }, settings);
            }
            catch (err) {
                logger.warn({ err, filePath }, 'settings.yaml reload failed validation/reconcile; keeping last good settings');
                return;
            }
            const reloaded = loadRuntimeSettings(options.runtimeHome);
            const classification = lastGoodSettings
                ? classifySettingsChanges(lastGoodSettings, reloaded)
                : { liveApplied: ['settings'], restartRequired: [] };
            lastGoodSettings = reloaded;
            invalidateSenderAllowlistCache(filePath);
            logger.info({
                filePath,
                liveApplied: classification.liveApplied,
                restartRequired: classification.restartRequired,
            }, 'settings.yaml reload reconciled');
        })().finally(() => {
            reloadInFlight = undefined;
            if (reloadQueued) {
                reloadQueued = false;
                void reload().catch((err) => logger.warn({ err, filePath }, 'queued settings.yaml reload failed'));
            }
        });
        return reloadInFlight;
    };
    fs.watchFile(filePath, { interval: options.pollIntervalMs ?? 5000 }, (current, previous) => {
        if (current.mtimeMs === previous.mtimeMs &&
            current.size === previous.size) {
            return;
        }
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        void reload().catch((err) => logger.warn({ err, filePath }, 'settings.yaml reload failed'));
    });
    return {
        close: () => {
            if (retryTimer)
                clearTimeout(retryTimer);
            fs.unwatchFile(filePath);
        },
    };
}
function settingsDocumentsMatch(left, right) {
    return (stableJson(settingsToRevisionDocument(left)) ===
        stableJson(settingsToRevisionDocument(right)));
}

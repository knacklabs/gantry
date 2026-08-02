import { loadRuntimeSettings, saveRuntimeSettings, } from './runtime-settings.js';
import { classifySettingsChanges } from './desired-state-service-helpers.js';
import { importWorkstationSettings, settingsFromRevisionDocument, } from './settings-import-service.js';
export function noteRestartRequired(input) {
    if (input.restartRequired?.length) {
        console.log('This change requires a restart to take effect — run `gantry restart`.');
    }
}
let storageProvider;
export function configureDesiredSettingsStorageProvider(provider) {
    storageProvider = provider;
}
/**
 * Single desired-state write path.
 *
 * Postgres `settings_revisions` is the durable authority for managed runtime
 * settings. The local `settings.yaml` file is updated by the shared import path
 * after the revision append succeeds.
 */
export async function writeDesiredRuntimeSettings(input) {
    const deploymentMode = input.settings.runtime.deploymentMode;
    if (!storageProvider) {
        const previousSettings = input.previousSettings ?? loadRuntimeSettings(input.runtimeHome);
        const restartRequired = classifySettingsChanges(previousSettings, input.settings).restartRequired;
        saveRuntimeSettings(input.runtimeHome, input.settings);
        return { reconciled: false, restartRequired };
    }
    const storage = await storageProvider({ settings: input.settings });
    if (!storage) {
        throw new Error('Settings mutation requires runtime storage so settings_revisions can be durably appended.');
    }
    if (!deploymentMode) {
        await storage.close?.();
        throw new Error('Settings mutation requires runtime.deploymentMode when runtime storage is available.');
    }
    if (!storage.settingsRevisions) {
        await storage.close?.();
        throw new Error('Settings mutation requires the settings revisions repository.');
    }
    try {
        const appId = input.appId ?? 'default';
        const previousSettings = input.previousSettings ?? loadRuntimeSettings(input.runtimeHome);
        const restartRequired = classifySettingsChanges(previousSettings, input.settings).restartRequired;
        await importWorkstationSettings({
            runtimeHome: input.runtimeHome,
            ops: storage.ops,
            repositories: storage.repositories,
            appId,
            previousSettings,
            revisionMirror: {
                settingsRevisions: storage.settingsRevisions,
                pool: storage.pool,
                createdBy: input.createdBy ?? 'cli:desired-settings-write',
            },
            revisionMirrorRequired: true,
        }, input.settings);
        return { reconciled: true, restartRequired };
    }
    finally {
        await storage.close?.();
    }
}
export async function loadDesiredRuntimeSettingsForWrite(input) {
    const fileSettings = input.settings ?? loadRuntimeSettings(input.runtimeHome);
    if (!storageProvider)
        return fileSettings;
    const storage = await storageProvider({ settings: fileSettings });
    if (!storage) {
        throw new Error('Settings mutation requires runtime storage so settings_revisions can be durably read.');
    }
    try {
        if (!storage.settingsRevisions)
            return fileSettings;
        const appId = input.appId ?? 'default';
        const latest = await storage.settingsRevisions.getLatestSettingsRevision(appId);
        if (!latest)
            return fileSettings;
        return settingsFromRevisionDocument(latest.settingsDocument);
    }
    finally {
        await storage.close?.();
    }
}

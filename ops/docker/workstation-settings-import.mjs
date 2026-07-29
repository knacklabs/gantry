import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../../dist/adapters/storage/postgres/runtime-store.js';
import { loadRuntimeSettingsFromPath } from '../../dist/config/index.js';
import {
  importWorkstationSettings,
  settingsFromRevisionDocument,
} from '../../dist/config/settings/settings-import-service.js';

const settingsPath = process.argv[2];
if (!settingsPath) {
  console.error(
    'usage: node /app/ops/docker/workstation-settings-import.mjs <settings.yaml>',
  );
  process.exit(1);
}

const appId = process.env.GANTRY_APP_ID?.trim() || 'default';
const runtimeHome = process.env.GANTRY_HOME || '/var/lib/gantry';
const settings = loadRuntimeSettingsFromPath(settingsPath);

await initializeRuntimeStorage({ runtimeSettings: settings });
try {
  const storage = getRuntimeStorage();
  const latest =
    await storage.repositories.settingsRevisions.getLatestSettingsRevision(
      appId,
    );
  const previousSettings = latest
    ? settingsFromRevisionDocument(latest.settingsDocument)
    : settings;
  const outcome = await importWorkstationSettings(
    {
      runtimeHome,
      ops: storage.ops,
      repositories: storage.repositories,
      appId,
      previousSettings,
      revisionMirror: {
        settingsRevisions: storage.repositories.settingsRevisions,
        pool: storage.service.pool,
        createdBy: 'docker:workstation-settings-import',
        note: process.env.GANTRY_SETTINGS_IMPORT_NOTE?.trim() || null,
      },
      revisionMirrorRequired: true,
      expectedRevision: latest?.revision ?? 0,
    },
    settings,
  );
  console.log(
    outcome.revision
      ? `workstation settings revision ${outcome.revision} imported for ${appId}`
      : `workstation settings already current for ${appId}`,
  );
} finally {
  await closeRuntimeStorage();
}

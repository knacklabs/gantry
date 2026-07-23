import fs from 'node:fs';
import path from 'node:path';

import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../../config/settings/runtime-settings.js';
import {
  GANTRY_HOME,
  resolveRuntimeBootstrapStorageConfigFromEnv,
  readRuntimeSecretEnv,
} from '../../config/index.js';
import type { AppId } from '../../domain/app/app.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  initTracing,
  parseOtlpHeaders,
  shutdownTracing,
} from '../../infrastructure/observability/tracing.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';
import { initializeRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import { SettingsDesiredStateService } from '../../config/settings/desired-state-service.js';
import {
  CURRENT_SETTINGS_READER_VERSION,
  importWorkstationSettings,
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
  stableJson,
} from '../../config/settings/settings-import-service.js';
import { loadSessionAppMemoryItems } from '../../memory/app-memory-session-hydration.js';
import { RuntimeApp } from './runtime-app.js';
import { nowIso } from '../../shared/time/datetime.js';

interface SettingsImportPreflightFailure {
  summary: string;
  details: string[];
}

interface SettingsImportPreflightResult {
  ok: boolean;
  failure?: SettingsImportPreflightFailure;
}

type ValidateSettingsImportPreflight = (
  runtimeHome: string,
) => SettingsImportPreflightResult;

type FormatSettingsImportPreflightFailure = (
  failure: SettingsImportPreflightFailure,
) => string;

interface StartupDeps {
  ensureRuntimeLayoutDirectories: typeof ensureRuntimeLayoutDirectories;
  initializeRuntimeStorage: typeof initializeRuntimeStorage;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  importWorkstationSettings: typeof importWorkstationSettings;
  settingsFileExists: (runtimeHome: string) => boolean;
  validateSettingsImportPreflight: ValidateSettingsImportPreflight;
  formatRuntimePreflightFailure: FormatSettingsImportPreflightFailure;
  logger: Pick<typeof logger, 'info' | 'warn'>;
  settingsAuthority: 'file' | 'revision';
}

export interface StartupResult {
  runtimeSettings: RuntimeSettings;
  initTracingFromSettings: (settings: RuntimeSettings) => void;
  closeTracing: () => Promise<void>;
}

const STARTUP_CREDENTIAL_BINDING_TIMEOUT_MS = 3_000;
const DEFAULT_AGENT_FOLDER = 'main_agent';
const INTERNAL_DEFAULT_AGENT_JID = 'app:default';

function makeDefaultDeps(): StartupDeps {
  return {
    ensureRuntimeLayoutDirectories,
    initializeRuntimeStorage,
    loadRuntimeSettings,
    importWorkstationSettings,
    settingsFileExists: (runtimeHome) =>
      fs.existsSync(path.join(runtimeHome, 'settings.yaml')),
    validateSettingsImportPreflight: () => ({ ok: true }),
    formatRuntimePreflightFailure: (failure) =>
      [failure.summary, ...failure.details.map((line) => `- ${line}`)].join(
        '\n',
      ),
    logger,
    settingsAuthority: 'file',
  };
}

export async function runStartup(
  app: RuntimeApp,
  deps: Partial<StartupDeps> = {},
): Promise<StartupResult> {
  const resolved: StartupDeps = {
    ...makeDefaultDeps(),
    ...deps,
  };

  resolved.ensureRuntimeLayoutDirectories(GANTRY_HOME);
  let storage = await initializeStartupStorage(resolved);
  resolved.logger.info('Database initialized');
  const runtimeSettings = await (async () => {
    if (resolved.settingsAuthority !== 'revision') {
      return resolved.loadRuntimeSettings(GANTRY_HOME);
    }
    const revisionSettings = await loadRevisionAuthoritySettings({
      runtimeHome: GANTRY_HOME,
      storage,
      app,
      loadRuntimeSettings: resolved.loadRuntimeSettings,
      importWorkstationSettings: resolved.importWorkstationSettings,
      settingsFileExists: resolved.settingsFileExists,
      validateSettingsImportPreflight: resolved.validateSettingsImportPreflight,
      formatRuntimePreflightFailure: resolved.formatRuntimePreflightFailure,
      logger: resolved.logger,
    });
    await closeStartupStorage(storage);
    storage = await resolved.initializeRuntimeStorage({
      loadSessionAppMemoryItems: loadSessionAppMemoryItems,
      runtimeSettings: revisionSettings,
    });
    resolved.logger.info(
      'Database initialized with authoritative settings revision',
    );
    return revisionSettings;
  })();
  if (
    resolved.settingsAuthority === 'file' &&
    runtimeSettings.desiredState &&
    runtimeSettings.agents &&
    process.env.GANTRY_SKIP_RECONCILE_ON_STARTUP !== '1'
  ) {
    const desiredState = new SettingsDesiredStateService({
      ops: storage.ops,
      repositories: storage.repositories,
    });
    const reconcile = await desiredState.reconcile(runtimeSettings);
    if (reconcile.invalidReferences.length > 0) {
      throw new Error(
        `settings desired state contains invalid references:\n${reconcile.invalidReferences.join('\n')}`,
      );
    }
    if (reconcile.applied.length > 0 || reconcile.skipped.length > 0) {
      resolved.logger.info(
        {
          applied: reconcile.applied,
          skipped: reconcile.skipped,
          authoritative: runtimeSettings.desiredState.authoritative,
        },
        'Settings desired state reconciled',
      );
    }
  } else if (process.env.GANTRY_SKIP_RECONCILE_ON_STARTUP === '1') {
    resolved.logger.warn(
      'Skipping settings desired-state startup reconcile because GANTRY_SKIP_RECONCILE_ON_STARTUP=1',
    );
  }
  await app.loadState();
  await ensureFreshRuntimeHasDefaultAgent(
    app,
    runtimeSettings,
    resolved.logger,
  );
  await waitForCredentialBindings(app, resolved.logger);

  // Deliberately NOT called here: split fleet roles enter runStartup with
  // settingsAuthority 'file' and only obtain the authoritative revision via
  // prepareFleetSettings() afterwards. The caller invokes this exactly once
  // when settings are final so tracing never configures from a stale mirror.
  const initTracingFromSettings = (settings: RuntimeSettings): void => {
    try {
      const tracing = settings.observability.tracing;
      initTracing({
        enabled: tracing.enabled,
        endpoint: tracing.endpoint || undefined,
        // Managed services (launchd/systemd) pass a minimal process env;
        // runtime secrets live in GANTRY_HOME/.env (process env still wins).
        headers: parseOtlpHeaders(
          readRuntimeSecretEnv('GANTRY_OTEL_TRACES_HEADERS'),
        ),
        captureContent: tracing.captureContent,
        sampleRate: tracing.sampleRate,
        environment: tracing.environment,
      });
    } catch (err) {
      resolved.logger.warn({ err }, 'Failed to initialize tracing');
    }
  };

  return {
    runtimeSettings,
    initTracingFromSettings,
    closeTracing: shutdownTracing,
  };
}

async function closeStartupStorage(
  storage: Awaited<ReturnType<typeof initializeRuntimeStorage>>,
): Promise<void> {
  await storage.runtimeEventNotifier?.close?.().catch(() => undefined);
  await storage.service?.close?.().catch(() => undefined);
}

async function initializeStartupStorage(
  resolved: StartupDeps,
): ReturnType<typeof initializeRuntimeStorage> {
  const baseOptions = {
    loadSessionAppMemoryItems: loadSessionAppMemoryItems,
  };
  if (resolved.settingsAuthority !== 'revision') {
    return resolved.initializeRuntimeStorage(baseOptions);
  }
  const bootstrapStorageConfig =
    resolveRuntimeBootstrapStorageConfigFromEnv() ?? undefined;
  if (!resolved.settingsFileExists(GANTRY_HOME)) {
    return resolved.initializeRuntimeStorage({
      ...baseOptions,
      storageConfig: bootstrapStorageConfig,
    });
  }
  try {
    return await resolved.initializeRuntimeStorage(baseOptions);
  } catch (err) {
    if (!bootstrapStorageConfig || !isRuntimeStorageSettingsError(err)) {
      throw err;
    }
    return resolved.initializeRuntimeStorage({
      ...baseOptions,
      storageConfig: bootstrapStorageConfig,
    });
  }
}

function isRuntimeStorageSettingsError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith('Invalid runtime storage settings:')
  );
}

async function loadRevisionAuthoritySettings(input: {
  runtimeHome: string;
  storage: Awaited<ReturnType<typeof initializeRuntimeStorage>>;
  app: RuntimeApp;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  importWorkstationSettings: typeof importWorkstationSettings;
  settingsFileExists: (runtimeHome: string) => boolean;
  validateSettingsImportPreflight: ValidateSettingsImportPreflight;
  formatRuntimePreflightFailure: FormatSettingsImportPreflightFailure;
  logger: StartupDeps['logger'];
}): Promise<RuntimeSettings> {
  const appId = 'default' as AppId;
  const latest =
    await input.storage.repositories.settingsRevisions.getLatestSettingsRevision(
      appId,
    );
  if (latest) {
    if (latest.minReaderVersion > CURRENT_SETTINGS_READER_VERSION) {
      throw new Error(
        `Settings revision ${latest.revision} requires settings reader version ` +
          `${latest.minReaderVersion}; this runtime supports ${CURRENT_SETTINGS_READER_VERSION}. ` +
          'Upgrade Gantry before applying this revision.',
      );
    }
    const settings = settingsFromRevisionDocument(latest.settingsDocument);
    if (input.settingsFileExists(input.runtimeHome)) {
      let fileSettings: RuntimeSettings | null = null;
      try {
        fileSettings = input.loadRuntimeSettings(input.runtimeHome);
      } catch (err) {
        input.logger.warn(
          { err, appId, revision: latest.revision },
          'settings.yaml is invalid; using latest settings revision',
        );
      }
      if (
        fileSettings &&
        stableJson(settingsToRevisionDocument(fileSettings)) !==
          stableJson(latest.settingsDocument)
      ) {
        input.logger.warn(
          { appId, revision: latest.revision },
          'settings.yaml differs from latest settings revision; restoring revision-authority mirror',
        );
      }
    }
    await input.importWorkstationSettings(
      {
        runtimeHome: input.runtimeHome,
        ops: input.storage.ops,
        repositories: input.storage.repositories,
        appId,
      },
      settings,
    );
    input.logger.info(
      { appId, revision: latest.revision },
      'Loaded workstation settings from settings revision',
    );
    return settings;
  }

  const settings = input.loadRuntimeSettings(input.runtimeHome);
  if (settings.runtime.deploymentMode === 'fleet') {
    input.logger.warn(
      { appId },
      'No settings revision exists; fleet startup will not promote local settings.yaml to durable authority',
    );
    return settings;
  }
  assertSettingsImportPreflight(input);
  const outcome = await input.importWorkstationSettings(
    {
      runtimeHome: input.runtimeHome,
      ops: input.storage.ops,
      repositories: input.storage.repositories,
      appId,
      previousSettings: settings,
      revisionMirror: {
        settingsRevisions: input.storage.repositories.settingsRevisions,
        pool: input.storage.service.pool,
        createdBy: 'startup:settings.yaml-bootstrap',
        logWarn: (context, message) => input.logger.warn(context, message),
      },
      revisionMirrorRequired: true,
      expectedRevision: 0,
    },
    settings,
  );
  input.logger.info(
    {
      appId,
      revision: outcome.status === 'revision_created' ? outcome.revision : 0,
    },
    'Seeded workstation settings revision from settings.yaml',
  );
  return settings;
}

function assertSettingsImportPreflight(input: {
  runtimeHome: string;
  validateSettingsImportPreflight: ValidateSettingsImportPreflight;
  formatRuntimePreflightFailure: FormatSettingsImportPreflightFailure;
}): void {
  const validation = input.validateSettingsImportPreflight(input.runtimeHome);
  if (validation.ok) return;
  if (validation.failure) {
    throw new Error(input.formatRuntimePreflightFailure(validation.failure));
  }
  throw new Error('Runtime settings preflight failed.');
}

async function ensureFreshRuntimeHasDefaultAgent(
  app: RuntimeApp,
  runtimeSettings: RuntimeSettings,
  logger: StartupDeps['logger'],
): Promise<void> {
  const bindings = app.getConversationRoutes();
  if (Object.keys(bindings).length > 0) return;

  const jid = INTERNAL_DEFAULT_AGENT_JID;
  if (bindings[jid]) return;

  const agentName = runtimeSettings.agent?.name?.trim() || 'Default Agent';
  const binding = {
    name: agentName,
    folder: DEFAULT_AGENT_FOLDER,
    trigger: `@${agentName}`,
    added_at: nowIso(),
    requiresTrigger: false,
  };

  await app.registerGroup(jid, binding);
  logger.info(
    { jid, folder: DEFAULT_AGENT_FOLDER },
    'Registered default agent id main_agent for fresh runtime',
  );
}

async function waitForCredentialBindings(
  app: RuntimeApp,
  logger: StartupDeps['logger'],
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bindings = app.ensureCredentialBindingsForConversationRoutes();
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(
      () => resolve('timeout'),
      STARTUP_CREDENTIAL_BINDING_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([
      bindings.then(() => 'done' as const),
      timeoutPromise,
    ]);
    if (result === 'timeout') {
      logger.warn(
        {
          timeoutMs: STARTUP_CREDENTIAL_BINDING_TIMEOUT_MS,
        },
        'Gantry Model Gateway binding did not finish during startup; continuing channel startup',
      );
      bindings.catch((err) => {
        logger.warn(
          { err },
          'Gantry Model Gateway binding failed after startup continued',
        );
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Gantry Model Gateway binding failed during startup');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

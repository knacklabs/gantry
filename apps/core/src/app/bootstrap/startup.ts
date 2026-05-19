import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../../config/settings/runtime-settings.js';
import { GANTRY_HOME } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';
import { initializeRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import { SettingsDesiredStateService } from '../../config/settings/desired-state-service.js';
import { loadSessionAppMemoryItems } from '../../memory/app-memory-session-hydration.js';
import { RuntimeApp } from './runtime-app.js';
import { nowIso } from '../../shared/time/datetime.js';

interface StartupDeps {
  ensureRuntimeLayoutDirectories: typeof ensureRuntimeLayoutDirectories;
  initializeRuntimeStorage: typeof initializeRuntimeStorage;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  logger: Pick<typeof logger, 'info' | 'warn'>;
}

export interface StartupResult {
  runtimeSettings: RuntimeSettings;
}

const STARTUP_CREDENTIAL_BINDING_TIMEOUT_MS = 3_000;
const DEFAULT_AGENT_FOLDER = 'main_agent';
const INTERNAL_DEFAULT_AGENT_JID = 'app:default';

function makeDefaultDeps(): StartupDeps {
  return {
    ensureRuntimeLayoutDirectories,
    initializeRuntimeStorage,
    loadRuntimeSettings,
    logger,
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
  const runtimeSettings = resolved.loadRuntimeSettings(GANTRY_HOME);
  const storage = await resolved.initializeRuntimeStorage({
    loadSessionAppMemoryItems: loadSessionAppMemoryItems,
  });
  resolved.logger.info('Database initialized');
  if (
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

  return {
    runtimeSettings,
  };
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
        'Credential broker binding did not finish during startup; continuing channel startup',
      );
      bindings.catch((err) => {
        logger.warn(
          { err },
          'Credential broker binding failed after startup continued',
        );
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Credential broker binding failed during startup');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

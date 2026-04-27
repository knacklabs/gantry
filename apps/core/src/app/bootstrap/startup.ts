import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../../config/settings/runtime-settings.js';
import { MYCLAW_HOME } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';
import { ensurePromptProfileBootstrapped } from '../../runtime/prompt-profile.js';
import { restoreRemoteControl } from '../../runtime/remote-control.js';
import { initializeRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import { RuntimeApp } from './runtime-app.js';

interface StartupDeps {
  ensureRuntimeLayoutDirectories: typeof ensureRuntimeLayoutDirectories;
  ensurePromptProfileBootstrapped: typeof ensurePromptProfileBootstrapped;
  initializeRuntimeStorage: typeof initializeRuntimeStorage;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  restoreRemoteControl: typeof restoreRemoteControl;
  logger: Pick<typeof logger, 'info' | 'warn'>;
}

export interface StartupResult {
  runtimeSettings: RuntimeSettings;
}

const STARTUP_CREDENTIAL_BINDING_TIMEOUT_MS = 3_000;

function makeDefaultDeps(): StartupDeps {
  return {
    ensureRuntimeLayoutDirectories,
    ensurePromptProfileBootstrapped,
    initializeRuntimeStorage,
    loadRuntimeSettings,
    restoreRemoteControl,
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

  resolved.ensureRuntimeLayoutDirectories(MYCLAW_HOME);
  try {
    resolved.ensurePromptProfileBootstrapped();
  } catch (err) {
    resolved.logger.warn(
      { err },
      'Failed to seed prompt profile files; continuing startup',
    );
  }

  const runtimeSettings = resolved.loadRuntimeSettings(MYCLAW_HOME);
  await resolved.initializeRuntimeStorage();
  resolved.logger.info('Database initialized');
  await app.loadState();
  await waitForCredentialBindings(app, resolved.logger);

  resolved.restoreRemoteControl();

  return {
    runtimeSettings,
  };
}

async function waitForCredentialBindings(
  app: RuntimeApp,
  logger: StartupDeps['logger'],
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bindings = app.ensureCredentialBindingsForRegisteredGroups();
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

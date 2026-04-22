import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../cli/runtime-settings.js';
import { MYCLAW_HOME } from '../core/config.js';
import { logger } from '../core/logger.js';
import { ensureRuntimeLayoutDirectories } from '../platform/runtime-layout.js';
import { ensurePromptProfileBootstrapped } from '../runtime/prompt-profile.js';
import { restoreRemoteControl } from '../runtime/remote-control.js';
import { initDatabase } from '../storage/db.js';
import { RuntimeApp } from './runtime-app.js';

interface StartupDeps {
  ensureRuntimeLayoutDirectories: typeof ensureRuntimeLayoutDirectories;
  ensurePromptProfileBootstrapped: typeof ensurePromptProfileBootstrapped;
  initDatabase: typeof initDatabase;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  restoreRemoteControl: typeof restoreRemoteControl;
  logger: Pick<typeof logger, 'info' | 'warn'>;
}

export interface StartupResult {
  runtimeSettings: RuntimeSettings;
}

function makeDefaultDeps(): StartupDeps {
  return {
    ensureRuntimeLayoutDirectories,
    ensurePromptProfileBootstrapped,
    initDatabase,
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
  if (runtimeSettings.storage.provider !== 'sqlite') {
    throw new Error(
      'storage.provider=postgres is not available in host runtime yet. Use storage.provider=sqlite.',
    );
  }
  resolved.initDatabase();
  resolved.logger.info('Database initialized');
  app.loadState();
  app.ensureOneCLIAgentsForRegisteredGroups();

  resolved.restoreRemoteControl();

  return {
    runtimeSettings,
  };
}

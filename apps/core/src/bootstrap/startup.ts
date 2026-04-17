import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../cli/runtime-settings.js';
import { AGENT_ROOT } from '../core/config.js';
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

  resolved.ensureRuntimeLayoutDirectories(AGENT_ROOT);
  try {
    resolved.ensurePromptProfileBootstrapped();
  } catch (err) {
    resolved.logger.warn(
      { err },
      'Failed to seed prompt profile files; continuing startup',
    );
  }

  resolved.initDatabase();
  resolved.logger.info('Database initialized');

  const runtimeSettings = resolved.loadRuntimeSettings(AGENT_ROOT);
  app.loadState();
  app.ensureOneCLIAgentsForRegisteredGroups();

  resolved.restoreRemoteControl();

  return {
    runtimeSettings,
  };
}

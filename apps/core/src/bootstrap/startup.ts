import fs from 'fs';
import path from 'path';

import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../cli/runtime-settings.js';
import { AGENT_ROOT, DATA_DIR } from '../core/config.js';
import { logger } from '../core/logger.js';
import { ensureRuntimeLayoutDirectories } from '../platform/runtime-layout.js';
import { ensurePromptProfileBootstrapped } from '../runtime/prompt-profile.js';
import { refreshConfiguredAgentsFromDisk } from '../runtime/agent-config-registry.js';
import { refreshPermissionProfilesFromDisk } from '../runtime/permission-profile-registry.js';
import { restoreRemoteControl } from '../runtime/remote-control.js';
import { runRuntimeStartupPreflight } from '../runtime/runtime-diagnostics.js';
import { initDatabase } from '../storage/db.js';
import { RuntimeApp } from './runtime-app.js';

function signalOrphanedRunnersToExit(): void {
  const ipcRoot = path.join(DATA_DIR, 'ipc');
  try {
    if (!fs.existsSync(ipcRoot)) return;
    for (const group of fs.readdirSync(ipcRoot)) {
      const inputDir = path.join(ipcRoot, group, 'input');
      try {
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_close'), '');
      } catch {
        // best-effort
      }
    }
    logger.info('Signaled orphaned agent runners to exit');
  } catch {
    // best-effort
  }
}

interface StartupDeps {
  ensureRuntimeLayoutDirectories: typeof ensureRuntimeLayoutDirectories;
  ensurePromptProfileBootstrapped: typeof ensurePromptProfileBootstrapped;
  runRuntimeStartupPreflight: typeof runRuntimeStartupPreflight;
  initDatabase: typeof initDatabase;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  refreshConfiguredAgentsFromDisk: typeof refreshConfiguredAgentsFromDisk;
  refreshPermissionProfilesFromDisk: typeof refreshPermissionProfilesFromDisk;
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
    runRuntimeStartupPreflight,
    initDatabase,
    loadRuntimeSettings,
    refreshConfiguredAgentsFromDisk,
    refreshPermissionProfilesFromDisk,
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

  signalOrphanedRunnersToExit();
  resolved.ensureRuntimeLayoutDirectories(AGENT_ROOT);
  try {
    resolved.ensurePromptProfileBootstrapped();
  } catch (err) {
    resolved.logger.warn(
      { err },
      'Failed to seed prompt profile files; continuing startup',
    );
  }

  await resolved.runRuntimeStartupPreflight();
  resolved.initDatabase();
  resolved.logger.info('Database initialized');

  const runtimeSettings = resolved.loadRuntimeSettings(AGENT_ROOT);
  const configuredAgents = resolved.refreshConfiguredAgentsFromDisk();
  resolved.refreshPermissionProfilesFromDisk({ agents: configuredAgents });
  app.loadState();
  app.reconcileConfiguredAgentChannelBindings(configuredAgents);
  app.ensureOneCLIAgentsForRegisteredGroups();

  resolved.restoreRemoteControl();

  return {
    runtimeSettings,
  };
}

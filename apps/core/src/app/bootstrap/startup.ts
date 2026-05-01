import {
  RuntimeSettings,
  inferRecoverableMainAgentJid,
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
  inferRecoverableMainAgentJid: typeof inferRecoverableMainAgentJid;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  restoreRemoteControl: typeof restoreRemoteControl;
  logger: Pick<typeof logger, 'info' | 'warn'>;
}

export interface StartupResult {
  runtimeSettings: RuntimeSettings;
}

const STARTUP_CREDENTIAL_BINDING_TIMEOUT_MS = 3_000;
const MAIN_AGENT_FOLDER = 'main_agent';
const INTERNAL_MAIN_AGENT_JID = 'app:main';

function makeDefaultDeps(): StartupDeps {
  return {
    ensureRuntimeLayoutDirectories,
    ensurePromptProfileBootstrapped,
    initializeRuntimeStorage,
    inferRecoverableMainAgentJid,
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
  await ensureFreshRuntimeHasMainAgent(
    app,
    runtimeSettings,
    resolved.inferRecoverableMainAgentJid,
    resolved.logger,
  );
  await waitForCredentialBindings(app, resolved.logger);

  resolved.restoreRemoteControl();

  return {
    runtimeSettings,
  };
}

async function ensureFreshRuntimeHasMainAgent(
  app: RuntimeApp,
  runtimeSettings: RuntimeSettings,
  inferMainJid: typeof inferRecoverableMainAgentJid,
  logger: StartupDeps['logger'],
): Promise<void> {
  const bindings = app.getRegisteredGroups();
  if (Object.values(bindings).some((group) => group.isMain === true)) {
    return;
  }

  const targetJid = inferMainJid(runtimeSettings);
  if (!targetJid && Object.keys(bindings).length > 0) return;

  const jid = targetJid || INTERNAL_MAIN_AGENT_JID;
  if (bindings[jid]) return;

  const agentName = runtimeSettings.agent?.name?.trim() || 'Main Agent';
  const binding = {
    name: agentName,
    folder: MAIN_AGENT_FOLDER,
    trigger: `@${agentName}`,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
  };

  await app.registerGroup(jid, binding);
  logger.info(
    { jid, folder: MAIN_AGENT_FOLDER },
    'Registered default main agent for fresh runtime',
  );
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

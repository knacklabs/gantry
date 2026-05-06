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
import { SettingsDesiredStateService } from '../../config/settings/desired-state-service.js';
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
  const storage = await resolved.initializeRuntimeStorage();
  resolved.logger.info('Database initialized');
  if (
    runtimeSettings.desiredState &&
    runtimeSettings.agents &&
    process.env.MYCLAW_SKIP_RECONCILE_ON_STARTUP !== '1'
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
  } else if (process.env.MYCLAW_SKIP_RECONCILE_ON_STARTUP === '1') {
    resolved.logger.warn(
      'Skipping settings desired-state startup reconcile because MYCLAW_SKIP_RECONCILE_ON_STARTUP=1',
    );
  }
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
  const bindings = app.getConversationRoutes();
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

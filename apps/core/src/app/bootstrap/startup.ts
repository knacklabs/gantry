import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../../config/settings/runtime-settings.js';
import { GANTRY_HOME } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';
import { restoreRemoteControl } from '../../runtime/remote-control.js';
import { initializeRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import { SettingsDesiredStateService } from '../../config/settings/desired-state-service.js';
import { loadSessionAppMemoryItems } from '../../memory/app-memory-session-hydration.js';
import { RuntimeApp } from './runtime-app.js';
import { nowIso } from '../../shared/time/datetime.js';

interface StartupDeps {
  ensureRuntimeLayoutDirectories: typeof ensureRuntimeLayoutDirectories;
  initializeRuntimeStorage: typeof initializeRuntimeStorage;
  loadRuntimeSettings: typeof loadRuntimeSettings;
  restoreRemoteControl: typeof restoreRemoteControl;
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
  // Snapshot provider + agent settings on the app so the routing layer can
  // consult providers.<id>.default_agent and look up agent display names.
  app.setProviderSettings(runtimeSettings.providers);
  app.setAgentsSettings(runtimeSettings.agents);
  assertInteraktInboundRoutingConfigured(runtimeSettings, resolved.logger);
  await app.loadState();
  await ensureFreshRuntimeHasDefaultAgent(
    app,
    runtimeSettings,
    resolved.logger,
  );
  await waitForCredentialBindings(app, resolved.logger);

  resolved.restoreRemoteControl();

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

/**
 * If the Interakt provider is enabled, the runtime needs at least one way to
 * route NEW inbound `wa:*` customers to an agent. Fail fast at startup if
 * none is configured — otherwise new customers would be dropped at
 * first-message time with only a per-message warn log.
 *
 * Acceptable routing sources for new customers (any one is enough):
 *   - providers.interakt.default_agent — synthesizes a route per customer
 *   - a conversation flagged template: true with external_id starting `wa:`
 *     — clone source for new wa:* customers
 *
 * Note: a `wa:<phone>` conversation entry without template:true only routes
 * that ONE customer; it is NOT a routing source for new customers. And a
 * template:true conversation outside the wa:* JID space (e.g. tg:*) belongs
 * to a different provider and won't help Interakt routing — see
 * channel-persistence-handlers.findInteraktDirectRouteTemplate.
 *
 * This check inspects settings.yaml only; it doesn't consult the DB. The
 * intent is that settings.yaml fully describes how new customers reach an
 * agent. Stale DB-only state isn't a substitute for declared intent.
 */
function assertInteraktInboundRoutingConfigured(
  runtimeSettings: RuntimeSettings,
  logger: StartupDeps['logger'],
): void {
  const interakt = runtimeSettings.providers?.interakt;
  if (!interakt?.enabled) return;

  // Resolve each conversation to its registered JID so this check uses the
  // exact same identity space as the routing layer
  // (channel-persistence-handlers.findInteraktDirectRouteTemplate matches by
  // JID prefix). Going through jidForConfiguredConversation means the two
  // can't drift if the JID-derivation rules change in the future.
  const interaktTemplateJids: string[] = [];
  const providerConnections = runtimeSettings.providerConnections ?? {};
  for (const conversation of Object.values(
    runtimeSettings.conversations ?? {},
  )) {
    if (conversation.isTemplate !== true) continue;
    const connection = providerConnections[conversation.providerConnection];
    const jid =
      connection?.provider === 'interakt' &&
      !conversation.externalId.startsWith('wa:')
        ? `wa:${conversation.externalId}`
        : conversation.externalId;
    if (jid.startsWith('wa:')) interaktTemplateJids.push(jid);
  }

  // Ambiguity warning: more than one wa:* template means the matcher picks
  // by iteration order, which is non-deterministic relative to user intent.
  if (interaktTemplateJids.length > 1) {
    logger.warn(
      { templates: interaktTemplateJids },
      'Multiple template:true conversations are configured in the wa:* JID space. ' +
        'The routing layer picks one arbitrarily; consider consolidating to a single template.',
    );
  }

  if (interakt.defaultAgent) return;
  if (interaktTemplateJids.length > 0) return;
  throw new Error(
    'Interakt is enabled but no inbound routing is configured for new ' +
      'customers. Add `providers.interakt.default_agent: <agent_folder>` or ' +
      'a `template: true` conversation with `id: "wa:..."` to ' +
      '~/gantry/settings.yaml. New inbound provider customers cannot be ' +
      'routed.',
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

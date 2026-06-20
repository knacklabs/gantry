import {
  RuntimeSettings,
  loadRuntimeSettings,
} from '../../config/settings/runtime-settings.js';
import { GANTRY_HOME } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';
import {
  initializeRuntimeStorage,
  getRuntimeFileArtifactStore,
} from '../../adapters/storage/postgres/runtime-store.js';
import { syncAuthoredPromptsAtBoot } from '../../runtime/authored-prompt-boot-sync.js';
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
const INTERAKT_DEFAULT_AGENT_PREWARM_PREFIX = 'wa:__interakt_default_agent__:';

function makeDefaultDeps(): StartupDeps {
  return {
    ensureRuntimeLayoutDirectories,
    initializeRuntimeStorage,
    loadRuntimeSettings,
    logger,
  };
}

async function reapWarmPoolOrphans(
  app: RuntimeApp,
  logger: StartupDeps['logger'],
): Promise<void> {
  if (!app.warmPool?.reapOrphans) return;
  try {
    const reaped = await app.warmPool.reapOrphans();
    if (reaped > 0) {
      logger.info(
        { reaped },
        'Reaped orphaned warm-pool workers from a previous runtime',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to reap orphaned warm-pool workers during startup',
    );
  }
}

function agentConfigForRuntimeAgent(agent: RuntimeSettings['agents'][string]):
  | {
      model?: string;
      persona?: typeof agent.persona;
      plugins?: typeof agent.plugins;
      thinking?: typeof agent.thinking;
      promptSurface?: typeof agent.promptSurface;
      toolSurface?: typeof agent.toolSurface;
    }
  | undefined {
  const agentConfig =
    agent.model ||
    agent.persona ||
    agent.promptSurface ||
    agent.plugins ||
    agent.thinking ||
    agent.toolSurface
      ? {
          model: agent.model,
          persona: agent.persona,
          promptSurface: agent.promptSurface,
          plugins: agent.plugins,
          thinking: agent.thinking,
          toolSurface: agent.toolSurface,
        }
      : undefined;
  return agentConfig;
}

function interaktDefaultAgentPrewarmJid(agentFolder: string): string {
  return `${INTERAKT_DEFAULT_AGENT_PREWARM_PREFIX}${agentFolder}`;
}

async function prewarmInteraktDefaultAgentRoute(
  app: RuntimeApp,
  runtimeSettings: RuntimeSettings,
  logger: StartupDeps['logger'],
): Promise<void> {
  if (!app.warmPool?.prewarm) return;
  const defaultAgentFolder = runtimeSettings.providers?.interakt?.defaultAgent;
  if (!runtimeSettings.providers?.interakt?.enabled || !defaultAgentFolder) {
    return;
  }
  const agent = runtimeSettings.agents?.[defaultAgentFolder];
  if (!agent) return;
  const chatJid = interaktDefaultAgentPrewarmJid(defaultAgentFolder);
  const group = {
    name: agent.name,
    folder: agent.folder,
    trigger: `@${agent.name}`,
    added_at: nowIso(),
    requiresTrigger: false,
    conversationKind: 'dm' as const,
    ...(agentConfigForRuntimeAgent(agent)
      ? { agentConfig: agentConfigForRuntimeAgent(agent) }
      : {}),
  };
  try {
    await app.projectConversationRoute(chatJid, group);
    await app.prewarmAgentForConversationRoute(chatJid);
  } catch (err) {
    logger.warn(
      { err, chatJid, folder: agent.folder },
      'Failed to prewarm Interakt default-agent warm-pool route during startup',
    );
  } finally {
    await app.unregisterConversationRoute(chatJid).catch((err) => {
      logger.warn(
        { err, chatJid, folder: agent.folder },
        'Failed to remove synthetic Interakt default-agent prewarm route',
      );
    });
  }
}

export async function prewarmWarmPoolRoutes(
  app: RuntimeApp,
  runtimeSettings: RuntimeSettings,
  logger: StartupDeps['logger'],
): Promise<void> {
  if (!app.warmPool?.prewarm) return;
  await prewarmInteraktDefaultAgentRoute(app, runtimeSettings, logger);
  const routes = Object.keys(app.getConversationRoutes());
  const hasProviderDefaultAgent =
    runtimeSettings.providers?.interakt?.enabled === true &&
    Boolean(runtimeSettings.providers.interakt.defaultAgent);
  const hasNonInternalRoute = routes.some(
    (chatJid) => chatJid !== INTERNAL_DEFAULT_AGENT_JID,
  );
  for (const chatJid of routes) {
    if (
      chatJid === INTERNAL_DEFAULT_AGENT_JID &&
      (hasProviderDefaultAgent || hasNonInternalRoute)
    ) {
      continue;
    }
    void app.prewarmAgentForConversationRoute(chatJid).catch((err) => {
      logger.warn(
        { err, chatJid },
        'Failed to prewarm warm-pool route during startup',
      );
    });
  }
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
    // Files (SOUL.md/CLAUDE.md) are the source of truth for each agent's
    // prompt. reconcile() above ensured the agent rows exist, so sync the
    // authored files into the prompt-profile store now (write-on-change,
    // versioned). A present-but-empty SOUL/CLAUDE throws here and aborts
    // startup (fail-loud), exactly at server start.
    await syncAuthoredPromptsAtBoot({
      agents: runtimeSettings.agents,
      getFileArtifactStore: () => getRuntimeFileArtifactStore(),
      logger: resolved.logger,
    });
  } else if (
    runtimeSettings.agents &&
    (process.env.GANTRY_SKIP_RECONCILE_ON_STARTUP === '1' ||
      !runtimeSettings.desiredState)
  ) {
    // Reconcile did not run, so the authored-prompt sync — and with it the
    // present-but-empty SOUL/CLAUDE fail-loud check — is also skipped this boot
    // (the artifact write FKs to the agent rows reconcile creates, so it cannot
    // safely run on its own). Surface it rather than silently dropping the
    // startup invariant.
    resolved.logger.warn(
      {
        skipReconcile: process.env.GANTRY_SKIP_RECONCILE_ON_STARTUP === '1',
        hasDesiredState: Boolean(runtimeSettings.desiredState),
      },
      'Settings desired-state reconcile skipped at startup; authored-prompt sync and its empty SOUL/CLAUDE fail-loud check are NOT enforced this boot',
    );
  }
  // Snapshot provider + agent settings on the app so the routing layer can
  // consult providers.<id>.default_agent and look up agent display names.
  app.setProviderSettings(runtimeSettings.providers);
  app.setAgentsSettings(runtimeSettings.agents);
  assertInteraktInboundRoutingConfigured(runtimeSettings, resolved.logger);
  await reapWarmPoolOrphans(app, resolved.logger);
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

/**
 * If the Interakt provider is enabled, the runtime needs at least one way to
 * route NEW inbound `wa:*` customers to an agent. Fail fast at startup if
 * none is configured — otherwise new customers would be dropped at
 * first-message time with only a per-message warn log.
 *
 * Acceptable routing sources for new customers (any one is enough):
 *   - providers.interakt.default_agent — projects a live virtual route per
 *     customer without persisting a route row
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

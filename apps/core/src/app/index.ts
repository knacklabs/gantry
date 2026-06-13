import {
  installGlobalErrorHandlers,
  logger,
} from '../infrastructure/logging/logger.js';
import { createChannelWiring } from './bootstrap/channel-wiring.js';
import { getDefaultRuntimeApp } from './bootstrap/runtime-app.js';
import { createReplyTraceWiring } from './bootstrap/reply-trace-wiring.js';
import { startRuntimeServices } from './bootstrap/runtime-services.js';
import { installShutdownHandlers } from './bootstrap/shutdown.js';
import { runStartup } from './bootstrap/startup.js';
import {
  closeRuntimeStorage,
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeSkillArtifactStore,
  getRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import { startControlServer } from '../control/server/index.js';
import { stopSchedulerLoop } from '../jobs/scheduler.js';
import { stopOutboundDeliveryRecoveryLoop } from '../jobs/outbound-delivery-recovery.js';
import { publishBrowserJobActivityEvent } from '../jobs/browser-activity-events.js';
import { GANTRY_HOME } from '../config/index.js';
import { hydrateDynamicRuntimeEnv } from '../config/env/index.js';
import { getBrowserStatus } from '../runtime/browser-capability.js';
import { startSettingsReloadWatcher } from '../runtime/settings-reload-watcher.js';
import {
  formatRuntimePreflightFailure,
  validateRuntimePreflightWithStorage,
} from '../config/preflight.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import { defaultHostnameLookup } from '../infrastructure/network/hostname-lookup.js';

export { escapeXml, formatMessages } from '../messaging/router.js';
export {
  getAvailableGroups,
  _setConversationRoutes,
} from './bootstrap/runtime-app.js';

export interface StartGantryRuntimeOptions {
  skipPreflight?: boolean;
  mcpHostnameLookup?: HostnameLookup;
}

export async function startGantryRuntime(
  options: StartGantryRuntimeOptions = {},
): Promise<void> {
  const mcpHostnameLookup = options.mcpHostnameLookup ?? defaultHostnameLookup;
  // Make these dev/test flags settable from $GANTRY_HOME/.env (they are read via
  // process.env in `shared`/`application` layers, which may not import config).
  // Keep them unset/off in production — see the DEV block in .env.
  hydrateDynamicRuntimeEnv([
    'GANTRY_FLOW_LOG',
    'GANTRY_OUTBOUND_DRYRUN',
    'GANTRY_TEST_OPERATOR_PHONE',
    'GANTRY_TEST_CALLER_IDENTITY_PHONE',
    // Developer-only child-runner switch (fails safe to dist when no source
    // tree exists); settable from .env so dev runs don't need a rebuild per
    // runner-side edit.
    'GANTRY_CHILD_RUNNER_FROM_SOURCE',
    // Dev-only: when '1', the per-reply latency trace also persists full
    // request/response + LLM input/output payloads (payloads_json). Timings are
    // always captured; only payload capture is gated. Off in production.
    'GANTRY_TRACE_PAYLOADS',
  ]);
  if (!options.skipPreflight) {
    const validation = await validateRuntimePreflightWithStorage(GANTRY_HOME);
    if (!validation.ok && validation.failure) {
      throw new Error(formatRuntimePreflightFailure(validation.failure));
    }
  }

  // One process-wide reply-trace wiring: a shared RunTraceCollector (MCP
  // capture ↔ persist-time drain) plus a best-effort trace repository.
  const replyTraceWiring = createReplyTraceWiring();
  const app = getDefaultRuntimeApp({
    mcpHostnameLookup: () => mcpHostnameLookup,
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
    replyTrace: replyTraceWiring.port,
  });
  const channelWiring = createChannelWiring(app, {
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
  });
  const controlServerRef: {
    current?: {
      close: () => Promise<void>;
    };
  } = {};
  app.setChannelRuntime({
    hasChannel: channelWiring.hasChannel,
    supportsStreaming: channelWiring.supportsStreaming,
    supportsProgress: channelWiring.supportsProgress,
    sendMessage: (chatJid, rawText, options) =>
      channelWiring.sendMessage(chatJid, rawText, {
        durability: 'required',
        messageOptions: options,
      }),
    sendStreamingChunk: channelWiring.sendStreamingChunk,
    resetStreaming: channelWiring.resetStreaming,
    setTyping: channelWiring.setTyping,
    sendProgressUpdate: channelWiring.sendProgressUpdate,
    isControlApproverAllowed: channelWiring.isControlApproverAllowed,
  });

  const { runtimeSettings } = await runStartup(app);
  const storage = getRuntimeStorage();
  const settingsWatcher = startSettingsReloadWatcher({
    runtimeHome: GANTRY_HOME,
    app,
    ops: storage.ops,
    repositories: storage.repositories,
  });
  const browserToolModulePath = [
    '..',
    'adapters',
    'browser',
    'browser-direct-driver.js',
  ].join('/');
  let browserToolModule: Promise<any> | undefined;
  const loadBrowserToolModule = () =>
    (browserToolModule ??= import(browserToolModulePath));
  const approvedCommandModulePath = [
    '..',
    'adapters',
    'sandbox',
    'approved-command-runner.js',
  ].join('/');
  let approvedCommandModule: Promise<any> | undefined;
  const loadApprovedCommandModule = () =>
    (approvedCommandModule ??= import(approvedCommandModulePath));

  installShutdownHandlers({
    queue: app.queue,
    disconnectChannels: channelWiring.disconnectChannels,
    closeControlServer: async () => {
      await controlServerRef.current?.close();
    },
    closeStorage: closeRuntimeStorage,
    closeScheduler: stopSchedulerLoop,
    closeOutboundDeliveryRecovery: stopOutboundDeliveryRecoveryLoop,
    closeSettingsWatcher: settingsWatcher.close,
    closeBrowserToolBackends: async () =>
      (await loadBrowserToolModule()).closeBrowserToolBackends(),
  });

  await channelWiring.connectEnabledChannels(runtimeSettings);

  if (!channelWiring.hasConnectedChannels()) {
    logger.warn(
      'No channels connected; runtime will continue without inbound/outbound channel delivery',
    );
  }

  await startRuntimeServices(
    {
      app,
      channelWiring,
    },
    {
      mcpHostnameLookup,
      opsRepository: storage.ops,
      getToolRepository: () => storage.repositories.tools,
      getSkillRepository: () => storage.repositories.skills,
      getMcpServerRepository: () => storage.repositories.mcpServers,
      getCapabilitySecretRepository: () =>
        storage.repositories.capabilitySecrets,
      runApprovedCommand: async (input) =>
        (await loadApprovedCommandModule()).runApprovedSandboxCommand(input),
      getSkillArtifactStore: getRuntimeSkillArtifactStore,
      getPermissionRepository: () => storage.repositories.permissions,
      settingsRepositories: storage.repositories,
      getOutboundDeliveryRepository: () =>
        storage.repositories.outboundDeliveries,
      publishRuntimeEvent: async (event) => {
        await getRuntimeEventExchange().publish(event);
      },
      callBrowserTool: async (input) =>
        (await loadBrowserToolModule()).callBrowserTool(input),
      publishBrowserJobActivity: async (input) => {
        const controlRepository = getRuntimeControlRepository();
        await publishBrowserJobActivityEvent({
          activity: input,
          getJobById: (jobId) => storage.ops.getJobById(jobId),
          controlRepository,
          publishRuntimeEvent: async (event) => {
            await getRuntimeEventExchange().publish(event);
          },
          logger,
        });
      },
      closeBrowserToolBackends: async (profileName) =>
        (await loadBrowserToolModule()).closeBrowserToolBackends(profileName),
      recordReplyToolCall: replyTraceWiring.recordReplyToolCall,
    },
  );
  controlServerRef.current = startControlServer({
    app,
    getBrowserStatus,
    sendConversationIngressProjection: async (input) => {
      await channelWiring.sendMessage(input.conversationJid, input.text, {
        durability: 'required',
        throwOnMissing: true,
        messageOptions: input.threadId
          ? { threadId: input.threadId }
          : undefined,
      });
    },
  });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  installGlobalErrorHandlers(logger);
  startGantryRuntime().catch((err) => {
    logger.error({ err }, 'Failed to start Gantry');
    process.exit(1);
  });
}

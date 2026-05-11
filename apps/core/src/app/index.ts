import {
  installGlobalErrorHandlers,
  logger,
} from '../infrastructure/logging/logger.js';
import { createChannelWiring } from './bootstrap/channel-wiring.js';
import { getDefaultRuntimeApp } from './bootstrap/runtime-app.js';
import { startRuntimeServices } from './bootstrap/runtime-services.js';
import { installShutdownHandlers } from './bootstrap/shutdown.js';
import { runStartup } from './bootstrap/startup.js';
import {
  closeRuntimeStorage,
  getRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import { startControlServer } from '../control/server/index.js';
import { stopSchedulerLoop } from '../jobs/scheduler.js';
import { stopOutboundDeliveryRecoveryLoop } from '../jobs/outbound-delivery-recovery.js';
import { MYCLAW_HOME } from '../config/index.js';
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

export interface StartMyClawRuntimeOptions {
  skipPreflight?: boolean;
  mcpHostnameLookup?: HostnameLookup;
}

export async function startMyClawRuntime(
  options: StartMyClawRuntimeOptions = {},
): Promise<void> {
  const mcpHostnameLookup = options.mcpHostnameLookup ?? defaultHostnameLookup;
  if (!options.skipPreflight) {
    const validation = await validateRuntimePreflightWithStorage(MYCLAW_HOME);
    if (!validation.ok && validation.failure) {
      throw new Error(formatRuntimePreflightFailure(validation.failure));
    }
  }

  const app = getDefaultRuntimeApp({
    mcpHostnameLookup: () => mcpHostnameLookup,
  });
  const channelWiring = createChannelWiring(app);
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
    runtimeHome: MYCLAW_HOME,
    app,
    ops: storage.ops,
    repositories: storage.repositories,
  });
  const browserToolModulePath = [
    '..',
    'adapters',
    'browser',
    'browser-tool-proxy.js',
  ].join('/');
  let browserToolModule: Promise<any> | undefined;
  const loadBrowserToolModule = () =>
    (browserToolModule ??= import(browserToolModulePath));

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
      getPermissionRepository: () => storage.repositories.permissions,
      settingsRepositories: storage.repositories,
      getOutboundDeliveryRepository: () =>
        storage.repositories.outboundDeliveries,
      callBrowserTool: async (input) =>
        (await loadBrowserToolModule()).callBrowserTool(input),
      closeBrowserToolBackends: async (profileName) =>
        (await loadBrowserToolModule()).closeBrowserToolBackends(profileName),
    },
  );
  controlServerRef.current = startControlServer({ app });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  installGlobalErrorHandlers(logger);
  startMyClawRuntime().catch((err) => {
    logger.error({ err }, 'Failed to start MyClaw');
    process.exit(1);
  });
}

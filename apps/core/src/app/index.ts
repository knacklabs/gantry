import {
  installGlobalErrorHandlers,
  logger,
} from '../infrastructure/logging/logger.js';
import { createChannelWiring } from './bootstrap/channel-wiring.js';
import { getDefaultRuntimeApp } from './bootstrap/runtime-app.js';
import { startRuntimeServices } from './bootstrap/runtime-services.js';
import { installShutdownHandlers } from './bootstrap/shutdown.js';
import { runStartup } from './bootstrap/startup.js';
import { closeRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { startControlServer } from '../control/server/index.js';
import { stopSchedulerLoop } from '../jobs/scheduler.js';
import { MYCLAW_HOME } from '../config/index.js';
import {
  formatRuntimePreflightFailure,
  validateRuntimePreflightWithStorage,
} from '../config/preflight.js';

export { escapeXml, formatMessages } from '../messaging/router.js';
export {
  getAvailableGroups,
  _setRegisteredGroups,
} from './bootstrap/runtime-app.js';

export interface StartMyClawRuntimeOptions {
  skipPreflight?: boolean;
}

export async function startMyClawRuntime(
  options: StartMyClawRuntimeOptions = {},
): Promise<void> {
  if (!options.skipPreflight) {
    const validation = await validateRuntimePreflightWithStorage(MYCLAW_HOME);
    if (!validation.ok && validation.failure) {
      throw new Error(formatRuntimePreflightFailure(validation.failure));
    }
  }

  const app = getDefaultRuntimeApp();
  const channelWiring = createChannelWiring(app);
  let controlServer:
    | {
        close: () => Promise<void>;
      }
    | undefined;
  app.setChannelRuntime({
    hasChannel: channelWiring.hasChannel,
    supportsStreaming: channelWiring.supportsStreaming,
    supportsProgress: channelWiring.supportsProgress,
    sendMessage: (chatJid, rawText, options) =>
      channelWiring.sendMessage(chatJid, rawText, {
        messageOptions: options,
      }),
    sendStreamingChunk: channelWiring.sendStreamingChunk,
    resetStreaming: channelWiring.resetStreaming,
    setTyping: channelWiring.setTyping,
    sendProgressUpdate: channelWiring.sendProgressUpdate,
  });

  const { runtimeSettings } = await runStartup(app);

  installShutdownHandlers({
    queue: app.queue,
    disconnectChannels: channelWiring.disconnectChannels,
    closeControlServer: async () => {
      await controlServer?.close();
    },
    closeStorage: closeRuntimeStorage,
    closeScheduler: stopSchedulerLoop,
  });

  await channelWiring.connectEnabledChannels(runtimeSettings);

  if (!channelWiring.hasConnectedChannels()) {
    logger.warn(
      'No channels connected; runtime will continue without inbound/outbound channel delivery',
    );
  }

  await startRuntimeServices({
    app,
    channelWiring,
  });
  controlServer = startControlServer({ app });
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

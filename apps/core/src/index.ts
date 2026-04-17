import { logger } from './core/logger.js';
import { createChannelWiring } from './bootstrap/channel-wiring.js';
import { getDefaultRuntimeApp } from './bootstrap/runtime-app.js';
import { startRuntimeServices } from './bootstrap/runtime-services.js';
import { installShutdownHandlers } from './bootstrap/shutdown.js';
import { runStartup } from './bootstrap/startup.js';

export { escapeXml, formatMessages } from './messaging/router.js';
export {
  getAvailableGroups,
  _setRegisteredGroups,
} from './bootstrap/runtime-app.js';

export async function startMyClawRuntime(): Promise<void> {
  const app = getDefaultRuntimeApp();
  const channelWiring = createChannelWiring(app);
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
  });

  await channelWiring.connectEnabledChannels(runtimeSettings);

  if (!channelWiring.hasConnectedChannels()) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  startRuntimeServices({
    app,
    channelWiring,
  });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  startMyClawRuntime().catch((err) => {
    logger.error({ err }, 'Failed to start MyClaw');
    process.exit(1);
  });
}

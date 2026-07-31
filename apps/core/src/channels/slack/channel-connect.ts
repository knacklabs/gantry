import { App, SocketModeReceiver } from '@slack/bolt';

import { logger } from '../../infrastructure/logging/logger.js';

// SocketModeClient emits this transport event synchronously when the active
// WebSocket closes, before its delayed reconnect and gateway discovery begin.
export const SLACK_SOCKET_MODE_RECONNECT_EVENT = 'close' as const;
export const SLACK_SOCKET_MODE_CONNECTED_EVENT = 'connected' as const;

export async function connectSlackApp(input: {
  botToken: string;
  appToken: string;
  inboundEnabled: boolean;
  interactionCallbacksEnabled: boolean;
  registerBoltHandlers: (app: App) => void;
  onReconnect?: () => void;
}): Promise<{ app: App; botUserId: string | null }> {
  const receiver = new SocketModeReceiver({ appToken: input.appToken });
  const app = new App({
    token: input.botToken,
    receiver,
  });
  if (input.inboundEnabled || input.interactionCallbacksEnabled) {
    let reconnectNeedsRefence = false;
    receiver.client.on(SLACK_SOCKET_MODE_RECONNECT_EVENT, () => {
      reconnectNeedsRefence = true;
      input.onReconnect?.();
    });
    receiver.client.on(SLACK_SOCKET_MODE_CONNECTED_EVENT, () => {
      if (!reconnectNeedsRefence) return;
      reconnectNeedsRefence = false;
      input.onReconnect?.();
    });
    input.registerBoltHandlers(app);
    app.error(async (error: Error) =>
      logger.error({ err: error }, 'Slack app error'),
    );
    await app.start();
  }
  try {
    const auth = (await app.client.auth.test()) as {
      user_id?: string;
      user?: string;
      team?: string;
    };
    const botUserId = auth.user_id || auth.user || null;
    logger.info(
      {
        team: auth.team,
        botUserId,
        inbound: input.inboundEnabled,
        interactionCallbacks: input.interactionCallbacksEnabled,
      },
      !input.inboundEnabled
        ? 'Slack outbound delivery client initialized'
        : 'Slack Socket Mode connected',
    );
    return { app, botUserId };
  } catch (err) {
    logger.warn({ err }, 'Slack auth.test failed after Socket Mode start');
    return { app, botUserId: null };
  }
}

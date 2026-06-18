import { App } from '@slack/bolt';

import { logger } from '../../infrastructure/logging/logger.js';

export async function connectSlackApp(input: {
  botToken: string;
  appToken: string;
  inboundEnabled: boolean;
  interactionCallbacksEnabled: boolean;
  registerBoltHandlers: (app: App) => void;
}): Promise<{ app: App; botUserId: string | null }> {
  const app = new App({
    token: input.botToken,
    appToken: input.appToken,
    socketMode: true,
  });
  if (input.inboundEnabled || input.interactionCallbacksEnabled) {
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

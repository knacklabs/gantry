import type { App } from '@slack/bolt';

import { logger } from '../../infrastructure/logging/logger.js';

export async function isSlackBotUser(input: {
  app: App | null;
  botUserId: string | null;
  cache: Map<string, boolean>;
  userId: string | undefined;
}): Promise<boolean> {
  if (!input.userId || input.userId === input.botUserId) return true;
  const cached = input.cache.get(input.userId);
  if (cached !== undefined) return cached;
  if (!input.app) return true;

  try {
    const result = (await input.app.client.users.info({
      user: input.userId,
    })) as { ok?: boolean; user?: { is_bot?: boolean } };
    const isBot = result.ok !== true || result.user?.is_bot !== false;
    input.cache.set(input.userId, isBot);
    return isBot;
  } catch (err) {
    logger.debug(
      { userId: input.userId, err },
      'Failed to resolve Slack user type',
    );
    return true;
  }
}

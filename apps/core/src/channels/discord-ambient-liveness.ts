import { logger } from '../infrastructure/logging/logger.js';
import {
  discordHeaders,
  discordReactionEmoji,
  DiscordRestError,
} from './discord-http-helpers.js';

type RequestJson = <T>(
  path: string,
  init: RequestInit,
  errorMessage: string,
  parseJson?: boolean,
) => Promise<T>;

function reactionPath(channelId: string, messageRef: string, reaction: string) {
  return `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageRef)}/reactions/${encodeURIComponent(reaction)}/@me`;
}

export async function addDiscordReaction(input: {
  botToken: string;
  channelId?: string;
  jid: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
  requestJson: RequestJson;
}): Promise<void> {
  if (!input.channelId || !input.messageRef.trim()) return;
  const reaction = discordReactionEmoji(input.emoji);
  const key = `${input.channelId}:${input.messageRef}:${reaction}`;
  if (input.reactionKeys.has(key)) return;
  try {
    await input.requestJson<void>(
      reactionPath(input.channelId, input.messageRef, reaction),
      { method: 'PUT', headers: discordHeaders(input.botToken) },
      'Discord reaction update failed',
      false,
    );
    input.reactionKeys.add(key);
  } catch (err) {
    logger.debug(
      { jid: input.jid, messageRef: input.messageRef, err },
      'Discord reaction update failed',
    );
  }
}

export async function removeDiscordReaction(input: {
  botToken: string;
  channelId?: string;
  jid: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
  requestJson: RequestJson;
}): Promise<void> {
  if (!input.channelId || !input.messageRef.trim()) return;
  const reaction = discordReactionEmoji(input.emoji);
  const key = `${input.channelId}:${input.messageRef}:${reaction}`;
  try {
    await input.requestJson<void>(
      reactionPath(input.channelId, input.messageRef, reaction),
      { method: 'DELETE', headers: discordHeaders(input.botToken) },
      'Discord reaction removal failed',
      false,
    );
    input.reactionKeys.delete(key);
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 404) {
      input.reactionKeys.delete(key);
      return;
    }
    logger.debug(
      { jid: input.jid, messageRef: input.messageRef, err },
      'Discord reaction removal failed',
    );
  }
}

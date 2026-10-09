import { updateReactionCache } from '../reaction-cache.js';
import {
  discordHeaders,
  discordReactionEmoji,
  DiscordRestError,
} from './http-helpers.js';

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
  signal?: AbortSignal;
  reconcile?: boolean;
  requestJson: RequestJson;
}): Promise<void> {
  if (!input.channelId || !input.messageRef.trim()) return;
  const channelId = input.channelId;
  const reaction = discordReactionEmoji(input.emoji);
  const key = `${input.channelId}:${input.messageRef}:${reaction}`;
  await updateReactionCache({ ...input, key, operation: 'add' }, async () => {
    await input.requestJson<void>(
      reactionPath(channelId, input.messageRef, reaction),
      { method: 'PUT', headers: discordHeaders(input.botToken) },
      'Discord reaction update failed',
      false,
    );
  });
}

export async function removeDiscordReaction(input: {
  botToken: string;
  channelId?: string;
  jid: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
  signal?: AbortSignal;
  reconcile?: boolean;
  requestJson: RequestJson;
}): Promise<void> {
  if (!input.channelId || !input.messageRef.trim()) return;
  const channelId = input.channelId;
  const reaction = discordReactionEmoji(input.emoji);
  const key = `${input.channelId}:${input.messageRef}:${reaction}`;
  await updateReactionCache(
    { ...input, key, operation: 'remove' },
    async () => {
      try {
        await input.requestJson<void>(
          reactionPath(channelId, input.messageRef, reaction),
          { method: 'DELETE', headers: discordHeaders(input.botToken) },
          'Discord reaction removal failed',
          false,
        );
      } catch (err) {
        if (err instanceof DiscordRestError && err.status === 404) {
          return;
        }
        throw err;
      }
    },
  );
}

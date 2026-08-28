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
  const reaction = discordReactionEmoji(input.emoji);
  const key = `${input.channelId}:${input.messageRef}:${reaction}`;
  if (!input.reconcile && input.reactionKeys.has(key)) return;
  if (input.reconcile) input.reactionKeys.delete(key);
  const invalidate = () => input.reactionKeys.delete(key);
  input.signal?.addEventListener('abort', invalidate, { once: true });
  try {
    await input.requestJson<void>(
      reactionPath(input.channelId, input.messageRef, reaction),
      { method: 'PUT', headers: discordHeaders(input.botToken) },
      'Discord reaction update failed',
      false,
    );
    if (!input.signal?.aborted) input.reactionKeys.add(key);
  } finally {
    input.signal?.removeEventListener('abort', invalidate);
  }
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
  const reaction = discordReactionEmoji(input.emoji);
  const key = `${input.channelId}:${input.messageRef}:${reaction}`;
  if (input.reconcile) input.reactionKeys.delete(key);
  const invalidate = () => input.reactionKeys.delete(key);
  input.signal?.addEventListener('abort', invalidate, { once: true });
  try {
    await input.requestJson<void>(
      reactionPath(input.channelId, input.messageRef, reaction),
      { method: 'DELETE', headers: discordHeaders(input.botToken) },
      'Discord reaction removal failed',
      false,
    );
    if (!input.signal?.aborted) input.reactionKeys.delete(key);
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 404) {
      if (!input.signal?.aborted) input.reactionKeys.delete(key);
      return;
    }
    throw err;
  } finally {
    input.signal?.removeEventListener('abort', invalidate);
  }
}

import { LiveUxRateLimitError } from '../../domain/channel-live-ux.js';
import type { LiveUxOperationOptions } from '../../domain/channel-live-ux.js';
import {
  addDiscordReaction,
  removeDiscordReaction,
} from './ambient-liveness.js';
import {
  discordHeaders,
  discordReactionEmoji,
  DiscordRestError,
  requestDiscordJson,
} from './http-helpers.js';

const DISCORD_API_ROOT = 'https://discord.com/api/v10';

function normalizedDiscordJid(jid: string): string | undefined {
  const trimmed = jid.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('dc:') ? trimmed : `dc:${trimmed}`;
}

function discordLiveUxChannelId(input: {
  jid: string;
  messageRef?: string;
  threadId?: string;
  resolveMessageChannelId(jid: string, messageRef: string): string | undefined;
}): string | undefined {
  const normalizedJid = normalizedDiscordJid(input.jid);
  if (input.threadId) return input.threadId;
  if (normalizedJid && input.messageRef) {
    const resolved = input.resolveMessageChannelId(
      normalizedJid,
      input.messageRef,
    );
    if (resolved) return resolved;
  }
  return normalizedJid?.slice('dc:'.length);
}

export function createDiscordLiveUxCapability(
  resolveMessageChannelId: (
    jid: string,
    messageRef: string,
  ) => string | undefined,
) {
  return {
    typing: 'expiring',
    reactions: { removal: 'exact' },
    canonicalTarget: (
      target:
        | { operation: 'typing'; jid: string; threadId?: string }
        | {
            operation: 'reaction';
            jid: string;
            threadId?: string;
            messageRef: string;
            emoji: string;
          },
    ) => {
      if (target.operation === 'typing') {
        const channel = discordLiveUxChannelId({
          ...target,
          resolveMessageChannelId,
        });
        const resolvedTarget = channel ?? target.jid.trim();
        return {
          key: `typing\n${resolvedTarget}`,
          resolvedTarget,
        };
      }
      const channel = discordLiveUxChannelId({
        ...target,
        resolveMessageChannelId,
      });
      return {
        key: `reaction\n${channel ?? `unresolved:${target.jid.trim()}`}\n${target.messageRef}\n${discordReactionEmoji(target.emoji)}`,
        ...(channel ? { resolvedTarget: channel } : {}),
      };
    },
  } as const;
}

export class DiscordLiveUxOperations {
  readonly capability;

  constructor(
    private readonly input: {
      botToken: string;
      reactionKeys: Set<string>;
      resolveMessageChannelId(
        jid: string,
        messageRef: string,
      ): string | undefined;
    },
  ) {
    this.capability = createDiscordLiveUxCapability(
      input.resolveMessageChannelId,
    );
  }

  async addReaction(
    jid: string,
    messageRef: string,
    emoji: string,
    options: LiveUxOperationOptions = {},
  ): Promise<void> {
    await addDiscordReaction({
      ...this.reactionInput(jid, messageRef, options),
      emoji,
    });
  }

  async removeReaction(
    jid: string,
    messageRef: string,
    emoji: string,
    options: LiveUxOperationOptions = {},
  ): Promise<void> {
    await removeDiscordReaction({
      ...this.reactionInput(jid, messageRef, options),
      emoji,
    });
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    options: LiveUxOperationOptions = {},
  ): Promise<void> {
    if (!isTyping) return;
    const channelId =
      typeof options.resolvedTarget === 'string'
        ? options.resolvedTarget
        : discordLiveUxChannelId({
            jid,
            threadId: options.threadId,
            resolveMessageChannelId: this.input.resolveMessageChannelId,
          });
    if (!channelId) return;
    await sendDiscordTyping(this.input.botToken, channelId, options.signal);
  }

  private reactionInput(
    jid: string,
    messageRef: string,
    options: LiveUxOperationOptions,
  ) {
    const channelId =
      typeof options.resolvedTarget === 'string'
        ? options.resolvedTarget
        : discordLiveUxChannelId({
            jid,
            messageRef,
            threadId: options.threadId,
            resolveMessageChannelId: this.input.resolveMessageChannelId,
          });
    if (!channelId) {
      throw new Error('Discord reaction target channel is unavailable');
    }
    return {
      botToken: this.input.botToken,
      channelId,
      jid,
      messageRef,
      reactionKeys: this.input.reactionKeys,
      signal: options.signal,
      reconcile: options.reconcile,
      requestJson: createDiscordLiveUxRequester(options.signal),
    };
  }
}

export async function requestDiscordLiveUxJson<T>(
  path: string,
  init: RequestInit,
  errorMessage: string,
  parseJson = false,
): Promise<T> {
  try {
    return await requestDiscordJson<T>({
      url: `${DISCORD_API_ROOT}${path}`,
      init,
      errorMessage,
      parseJson,
      maxAttempts: 1,
    });
  } catch (err) {
    if (err instanceof DiscordRestError && err.retryDelayMs !== undefined) {
      throw new LiveUxRateLimitError(err.retryDelayMs, err);
    }
    throw err;
  }
}

export function createDiscordLiveUxRequester(signal?: AbortSignal) {
  return <T>(
    path: string,
    init: RequestInit,
    errorMessage: string,
    parseJson?: boolean,
  ) =>
    requestDiscordLiveUxJson<T>(
      path,
      { ...init, signal },
      errorMessage,
      parseJson,
    );
}

export function sendDiscordTyping(
  botToken: string,
  channelId: string,
  signal?: AbortSignal,
): Promise<void> {
  return requestDiscordLiveUxJson<void>(
    `/channels/${encodeURIComponent(channelId)}/typing`,
    {
      method: 'POST',
      headers: discordHeaders(botToken),
      body: JSON.stringify({}),
      signal,
    },
    'Discord typing update failed',
  );
}

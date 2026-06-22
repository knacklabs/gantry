import type { MessageDeliveryResult } from '../domain/types.js';
import { PartialMessageDeliveryError } from '../domain/messages/partial-delivery.js';

const DISCORD_MESSAGE_MAX_LENGTH = 2000;

export type DiscordMessagePoster = (
  channelId: string,
  body: Record<string, unknown>,
) => Promise<{ id?: string }>;

export function splitDiscordText(text: string): string[] {
  const value = text || ' ';
  const parts: string[] = [];
  for (
    let index = 0;
    index < value.length;
    index += DISCORD_MESSAGE_MAX_LENGTH
  ) {
    parts.push(value.slice(index, index + DISCORD_MESSAGE_MAX_LENGTH));
  }
  return parts.length ? parts : [' '];
}

export async function postDiscordMessageParts(input: {
  channelId: string;
  parts: string[];
  components?: unknown[];
  post: DiscordMessagePoster;
}): Promise<MessageDeliveryResult> {
  const externalMessageIds: string[] = [];
  let deliveredParts = 0;
  for (let index = 0; index < input.parts.length; index += 1) {
    try {
      const posted = await input.post(input.channelId, {
        content: input.parts[index],
        allowed_mentions: { parse: [] },
        components:
          index === input.parts.length - 1 ? input.components : undefined,
      });
      if (posted.id) externalMessageIds.push(posted.id);
      deliveredParts += 1;
    } catch (err) {
      if (deliveredParts > 0) {
        const unsentTail = input.parts.slice(deliveredParts).join('');
        const partial = new PartialMessageDeliveryError({
          cause: err,
          deliveredChunks: deliveredParts,
          name: 'PartialDiscordDeliveryError',
          message: `Discord message partially delivered (${deliveredParts}/${input.parts.length} parts)`,
          totalChunks: input.parts.length,
        });
        Object.assign(partial, {
          provider: 'discord',
          deliveredParts,
          totalParts: input.parts.length,
          externalMessageIds,
          ...(unsentTail.trim()
            ? {
                retryTail: {
                  canonicalText: unsentTail,
                  providerPayload: {
                    provider: 'discord',
                    channelId: input.channelId,
                  },
                },
              }
            : {}),
          warnings: ['discord.partial_delivery'],
        });
        throw partial;
      }
      throw err;
    }
  }
  return {
    ...(externalMessageIds[0]
      ? { externalMessageId: externalMessageIds[0] }
      : {}),
    ...(externalMessageIds.length > 0 ? { externalMessageIds } : {}),
    deliveredParts,
    totalParts: input.parts.length,
    ...(input.parts.length > 1
      ? { warnings: [`discord.message.chunked:${input.parts.length}`] }
      : {}),
  };
}

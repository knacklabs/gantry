import type {
  MessageDeliveryResult,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { discordActionComponents } from './discord-components.js';
import { splitDiscordText } from './discord-delivery.js';

export type DiscordProgressPost = (
  text: string,
  components?: unknown[],
) => Promise<MessageDeliveryResult>;

export type DiscordProgressEdit = (
  messageId: string,
  body: Record<string, unknown>,
) => Promise<void>;

export async function sendDiscordProgressUpdate(input: {
  key: string;
  activeMessages: Map<string, string>;
  text: string;
  options: ProgressUpdateOptions;
  post: DiscordProgressPost;
  edit: DiscordProgressEdit;
}): Promise<void> {
  const existingMessageId = input.activeMessages.get(input.key);
  if (!existingMessageId && input.options.replaceOnly) return;
  if (!existingMessageId && input.options.done && !input.text.trim()) return;

  const components = input.options.done
    ? []
    : discordActionComponents(input.options);
  const parts = splitDiscordText(
    input.text || (input.options.done ? 'Done.' : ' '),
  );
  if (existingMessageId && parts.length === 1) {
    await input.edit(existingMessageId, {
      content: parts[0],
      allowed_mentions: { parse: [] },
      components,
    });
    if (input.options.done) input.activeMessages.delete(input.key);
    return;
  }

  if (existingMessageId) {
    await input.edit(existingMessageId, {
      content: 'Continued below.',
      allowed_mentions: { parse: [] },
      components: [],
    });
  }
  const result = await input.post(input.text, components);
  const nextId = result.externalMessageIds?.at(-1) || result.externalMessageId;
  if (nextId && !input.options.done)
    input.activeMessages.set(input.key, nextId);
  if (input.options.done) input.activeMessages.delete(input.key);
}

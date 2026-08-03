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

export class DiscordProgressIdentityLifecycle {
  private definitiveMissingIdentityByRoute = new Map<string, string>();
  private latestCreateAttemptByRoute = new Map<string, number>();
  private nextCreateAttemptSequence = 0;

  prepare(input: {
    routeKey: string;
    progressKey: string;
    text: string;
    options: ProgressUpdateOptions;
    hasHandle: boolean;
  }): {
    options: ProgressUpdateOptions;
    createAttemptSequence?: number;
  } {
    const attachedIdentityIsDefinitivelyMissing =
      input.options.progressCardIdentity !== undefined &&
      this.definitiveMissingIdentityByRoute.get(input.routeKey) ===
        input.options.progressCardIdentity;
    const options =
      input.options.progressCardIdentity && input.options.done
        ? {
            ...input.options,
            replaceOnly:
              input.options.replaceOnly ??
              !attachedIdentityIsDefinitivelyMissing,
          }
        : input.options;
    const createsCard =
      !input.hasHandle &&
      options.replaceOnly !== true &&
      !(options.done && !input.text.trim());
    if (!createsCard) return { options };

    const createAttemptSequence = this.nextCreateAttemptSequence++;
    this.latestCreateAttemptByRoute.set(input.routeKey, createAttemptSequence);
    this.definitiveMissingIdentityByRoute.delete(input.routeKey);
    return { options, createAttemptSequence };
  }

  settle(input: {
    routeKey: string;
    progressKey: string;
    done?: boolean;
    landed: boolean;
    createAttemptSequence?: number;
  }): void {
    if (
      input.createAttemptSequence !== undefined &&
      this.latestCreateAttemptByRoute.get(input.routeKey) ===
        input.createAttemptSequence
    ) {
      this.latestCreateAttemptByRoute.delete(input.routeKey);
      if (input.landed) {
        this.definitiveMissingIdentityByRoute.delete(input.routeKey);
      } else {
        this.definitiveMissingIdentityByRoute.set(
          input.routeKey,
          input.progressKey,
        );
      }
    }
    if (
      input.landed &&
      input.done &&
      this.definitiveMissingIdentityByRoute.get(input.routeKey) ===
        input.progressKey
    ) {
      this.definitiveMissingIdentityByRoute.delete(input.routeKey);
    }
  }
}

export async function sendDiscordProgressUpdate(input: {
  key: string;
  activeMessages: Map<string, string>;
  text: string;
  options: ProgressUpdateOptions;
  post: DiscordProgressPost;
  edit: DiscordProgressEdit;
}): Promise<boolean> {
  const existingMessageId = input.activeMessages.get(input.key);
  if (!existingMessageId && input.options.replaceOnly) return false;
  if (!existingMessageId && input.options.done && !input.text.trim())
    return false;

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
    return true;
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
  return Boolean(existingMessageId || nextId || input.options.done);
}

export async function sendDiscordProgressUpdateForRoute(input: {
  routeKey: string;
  key: string;
  activeMessages: Map<string, string>;
  identityLifecycle: DiscordProgressIdentityLifecycle;
  text: string;
  options: ProgressUpdateOptions;
  post: DiscordProgressPost;
  edit: DiscordProgressEdit;
}): Promise<boolean> {
  const prepared = input.identityLifecycle.prepare({
    routeKey: input.routeKey,
    progressKey: input.key,
    text: input.text,
    options: input.options,
    hasHandle: input.activeMessages.has(input.key),
  });
  const landed = await sendDiscordProgressUpdate({
    ...input,
    options: prepared.options,
  });
  input.identityLifecycle.settle({
    routeKey: input.routeKey,
    progressKey: input.key,
    done: input.options.done,
    landed,
    createAttemptSequence: prepared.createAttemptSequence,
  });
  return landed;
}

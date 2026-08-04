import type {
  MessageDeliveryResult,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { discordActionComponents } from './discord-components.js';
import { splitDiscordText } from './discord-delivery.js';
import {
  discordProgressPayloadFingerprint,
  repairRetainedTerminalParts,
  type RetainedTerminalRender,
} from './discord-progress-terminal-render.js';

/**
 * Provider implementations must honor the supplied AbortSignal. The progress
 * queue allows five seconds for abort settlement before advancing the key.
 */
export type DiscordProgressPost = (
  text: string,
  components?: unknown[],
  signal?: AbortSignal,
) => Promise<MessageDeliveryResult>;

/** Provider implementations must honor the supplied AbortSignal. */
export type DiscordProgressEdit = (
  messageId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<void>;

export async function dispatchDiscordProgressUpdate(input: {
  key: string;
  activeMessages: Map<string, string>;
  retainedMessageId?: string;
  retainedTerminalRender?: RetainedTerminalRender;
  recordEditedBase(messageId: string): void;
  text: string;
  options: ProgressUpdateOptions;
  post: DiscordProgressPost;
  edit: DiscordProgressEdit;
}): Promise<{
  accepted: boolean;
  createdMessageId?: string;
  createOutcome?: 'landed' | 'ambiguous' | 'definitively_missing';
  terminalMultipartCompleted?: boolean;
  terminalPartMessageIds?: string[];
  terminalPayloadFingerprint?: string;
}> {
  const existingMessageId =
    input.activeMessages.get(input.key) ?? input.retainedMessageId;
  if (
    input.options.done &&
    !input.text.trim() &&
    !input.activeMessages.has(input.key)
  ) {
    return { accepted: false };
  }
  if (!existingMessageId && input.options.replaceOnly) {
    return { accepted: false };
  }

  const components = input.options.done
    ? []
    : discordActionComponents(input.options);
  const parts = splitDiscordText(
    input.text || (input.options.done ? 'Done.' : ' '),
  );
  if (
    existingMessageId &&
    parts.length === 1 &&
    !input.retainedTerminalRender
  ) {
    await input.edit(existingMessageId, {
      content: parts[0],
      allowed_mentions: { parse: [] },
      components,
    });
    input.recordEditedBase(existingMessageId);
    return { accepted: true, createOutcome: 'landed' };
  }

  if (existingMessageId && input.options.done && input.retainedTerminalRender) {
    return repairRetainedTerminalParts({
      text: input.text,
      parts,
      components,
      retained: input.retainedTerminalRender,
      edit: input.edit,
      post: input.post,
      recordEditedBase: input.recordEditedBase,
    });
  }

  if (existingMessageId && input.options.done) {
    await input.edit(existingMessageId, {
      content: parts[0],
      allowed_mentions: { parse: [] },
      components: [],
    });
    input.recordEditedBase(existingMessageId);
    const result = await input.post(parts.slice(1).join(''), components);
    const addedIds =
      result.externalMessageIds ??
      (result.externalMessageId ? [result.externalMessageId] : []);
    const completeStructure = addedIds.length === parts.length - 1;
    return {
      accepted: true,
      ...(addedIds[0] ? { createdMessageId: addedIds[0] } : {}),
      createOutcome:
        result.deliveredParts === 0
          ? 'definitively_missing'
          : completeStructure
            ? 'landed'
            : 'ambiguous',
      terminalMultipartCompleted: true,
      terminalPartMessageIds: [existingMessageId, ...addedIds],
      ...(completeStructure
        ? {
            terminalPayloadFingerprint: discordProgressPayloadFingerprint(
              input.text,
            ),
          }
        : {}),
    };
  }

  if (existingMessageId) {
    await input.edit(existingMessageId, {
      content: 'Continued below.',
      allowed_mentions: { parse: [] },
      components: [],
    });
    input.recordEditedBase(existingMessageId);
  }
  const result = await input.post(input.text, components);
  const returnedMessageIds =
    result.externalMessageIds ??
    (result.externalMessageId ? [result.externalMessageId] : []);
  const nextId = input.options.done
    ? returnedMessageIds[0]
    : returnedMessageIds.at(-1);
  const definitivelyMissing = result.deliveredParts === 0;
  const terminalMultipart =
    !existingMessageId && input.options.done && parts.length > 1;
  const completeTerminalStructure =
    terminalMultipart && returnedMessageIds.length === parts.length;
  const terminalPartMessageIds =
    terminalMultipart && returnedMessageIds.length > 0
      ? returnedMessageIds
      : undefined;
  return {
    accepted: Boolean(existingMessageId || nextId || !definitivelyMissing),
    ...(nextId ? { createdMessageId: nextId } : {}),
    createOutcome: definitivelyMissing
      ? 'definitively_missing'
      : terminalMultipart && !completeTerminalStructure
        ? 'ambiguous'
        : nextId
          ? 'landed'
          : 'ambiguous',
    terminalMultipartCompleted:
      input.options.done === true &&
      parts.length > 1 &&
      (result.externalMessageIds?.length ?? result.deliveredParts ?? 0) > 1,
    ...(terminalPartMessageIds
      ? {
          terminalPartMessageIds,
        }
      : {}),
    ...(completeTerminalStructure
      ? {
          terminalPayloadFingerprint: discordProgressPayloadFingerprint(
            input.text,
          ),
        }
      : {}),
  };
}

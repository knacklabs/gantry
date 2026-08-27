import { createHash } from 'node:crypto';

import type { MessageDeliveryResult } from '../../domain/types.js';

export type RetainedTerminalRender = {
  messageIds: string[];
  payloadFingerprint?: string;
  ambiguousPayloadFingerprint?: string;
};

export function discordProgressPayloadFingerprint(text: string): string {
  return `${text.length}:${createHash('sha256').update(text).digest('base64url')}`;
}

export async function repairRetainedTerminalParts(input: {
  text: string;
  parts: string[];
  components?: unknown[];
  retained: RetainedTerminalRender;
  edit(messageId: string, body: Record<string, unknown>): Promise<void>;
  post(text: string, components?: unknown[]): Promise<MessageDeliveryResult>;
  recordEditedBase(messageId: string): void;
}): Promise<{
  accepted: true;
  createdMessageId?: string;
  createOutcome: 'landed' | 'ambiguous' | 'definitively_missing';
  terminalMultipartCompleted: true;
  terminalPartMessageIds: string[];
  terminalPayloadFingerprint?: string;
}> {
  const payloadFingerprint = discordProgressPayloadFingerprint(input.text);
  if (
    input.retained.payloadFingerprint === payloadFingerprint ||
    input.retained.ambiguousPayloadFingerprint === payloadFingerprint
  ) {
    const baseMessageId = input.retained.messageIds[0]!;
    await input.edit(baseMessageId, {
      content: input.parts[0],
      allowed_mentions: { parse: [] },
      components: input.components,
    });
    input.recordEditedBase(baseMessageId);
    return {
      accepted: true,
      createOutcome:
        input.retained.ambiguousPayloadFingerprint === payloadFingerprint
          ? 'ambiguous'
          : 'landed',
      terminalMultipartCompleted: true,
      terminalPartMessageIds: input.retained.messageIds,
      ...(input.retained.payloadFingerprint === payloadFingerprint
        ? { terminalPayloadFingerprint: input.retained.payloadFingerprint }
        : {}),
    };
  }

  for (let index = 0; index < input.retained.messageIds.length; index += 1) {
    const messageId = input.retained.messageIds[index]!;
    await input.edit(messageId, {
      content: input.parts[index] ?? ' ',
      allowed_mentions: { parse: [] },
      components: [],
    });
    if (index === 0) input.recordEditedBase(messageId);
  }

  const remainingText = input.parts
    .slice(input.retained.messageIds.length)
    .join('');
  if (!remainingText) {
    return {
      accepted: true,
      createOutcome: 'landed',
      terminalMultipartCompleted: true,
      terminalPartMessageIds: input.retained.messageIds,
      terminalPayloadFingerprint: payloadFingerprint,
    };
  }

  const result = await input.post(remainingText, input.components);
  const addedIds =
    result.externalMessageIds ??
    (result.externalMessageId ? [result.externalMessageId] : []);
  const completeStructure =
    addedIds.length === input.parts.length - input.retained.messageIds.length;
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
    terminalPartMessageIds: [...input.retained.messageIds, ...addedIds],
    ...(completeStructure
      ? {
          terminalPayloadFingerprint: discordProgressPayloadFingerprint(
            input.text,
          ),
        }
      : {}),
  };
}

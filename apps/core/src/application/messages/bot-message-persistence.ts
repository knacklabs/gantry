import type { RuntimeMessageRepository } from '../../domain/repositories/ops-repo.js';
import type { NewMessage } from '../../domain/types.js';
import {
  getPartialMessageDeliveryMetadata,
  isPartialMessageDeliveryError,
} from '../../domain/messages/partial-delivery.js';
import { isAmbiguousDurableDeliveryError } from '../../domain/messages/durable-delivery.js';

/** One receipt projection for complete and visibly partial bot messages. */
export async function persistBotMessage(
  repository: Pick<RuntimeMessageRepository, 'storeMessage'> | undefined,
  message: NewMessage,
  receipts: readonly unknown[] = [],
): Promise<void> {
  const ids = new Set<string>();
  const add = (values: readonly unknown[]) => {
    for (const value of values)
      if (typeof value === 'string' && value.length > 0) ids.add(value);
  };
  add([message.external_message_id, ...(message.external_message_ids ?? [])]);
  for (const receipt of receipts) {
    if (typeof receipt !== 'object' || receipt === null) continue;
    const result = isPartialMessageDeliveryError(receipt)
      ? getPartialMessageDeliveryMetadata(receipt)
      : receipt instanceof Error && !isAmbiguousDurableDeliveryError(receipt)
        ? {}
        : receipt;
    const refs = result as {
      externalMessageId?: unknown;
      externalMessageIds?: unknown;
    };
    add([refs.externalMessageId]);
    if (Array.isArray(refs.externalMessageIds)) add(refs.externalMessageIds);
  }
  const externalMessageIds = [...ids];
  await repository?.storeMessage({
    ...message,
    is_from_me: true,
    is_bot_message: true,
    ...(externalMessageIds.length > 0
      ? {
          external_message_id: externalMessageIds[0],
          external_message_ids: externalMessageIds,
        }
      : {}),
  });
}

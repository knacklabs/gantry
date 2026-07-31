import type { ConversationRoute, NewMessage } from '../domain/types.js';
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';

export async function groupTurnHasRequiredTrigger(input: {
  group: ConversationRoute;
  chatJid: string;
  triggerPattern: RegExp;
  messages: NewMessage[];
  continuation?: {
    threadId: string | null | undefined;
    hasPriorCursor: boolean;
    messageRepository: RuntimeMessageRepository;
    pageSize: number;
  };
}): Promise<boolean> {
  if (input.group.requiresTrigger === false) return true;
  const allowlistCfg = loadSenderAllowlist();
  const hasTrigger = input.messages.some(
    (message) =>
      input.triggerPattern.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(
          input.chatJid,
          message.sender,
          allowlistCfg,
          input.group.folder,
        )),
  );
  if (hasTrigger) return true;

  const continuation = input.continuation;
  if (!continuation?.threadId || !continuation.hasPriorCursor) {
    return false;
  }

  // A mention owns its provider thread, not the entire conversation.
  // This lets a user continue an agent-started thread naturally while keeping
  // unrelated human threads trigger-gated.
  const rootCandidates = await continuation.messageRepository.getMessagesSince(
    input.chatJid,
    '',
    continuation.pageSize,
    {
      threadId: continuation.threadId,
      providerAccountId: input.group.providerAccountId,
    },
  );
  return rootCandidates.some(
    (message) =>
      message.thread_id === continuation.threadId &&
      !message.reply_to_message_id &&
      input.triggerPattern.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(
          input.chatJid,
          message.sender,
          allowlistCfg,
          input.group.folder,
        )),
  );
}

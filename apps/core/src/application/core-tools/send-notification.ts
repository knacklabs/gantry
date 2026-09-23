import type {
  ConversationRoute,
  MessageSendOptions,
} from '../../domain/types.js';
import { parseAgentThreadQueueKey } from '../../shared/thread-queue-key.js';

export interface NotificationDestination {
  name: string;
  jid: string;
  providerAccountId: string;
}

export function notificationDestinations(input: {
  routes: Record<string, ConversationRoute>;
  sourceAgentFolder: string;
  providerAccountId?: string;
}): NotificationDestination[] {
  const destinations = new Map<string, NotificationDestination>();
  for (const [key, route] of Object.entries(input.routes)) {
    const parsed = parseAgentThreadQueueKey(key);
    const providerAccountId =
      parsed.providerAccountId ?? route.providerAccountId;
    if (
      route.folder !== input.sourceAgentFolder ||
      !providerAccountId ||
      (input.providerAccountId !== undefined &&
        providerAccountId !== input.providerAccountId) ||
      route.conversationKind !== 'channel' ||
      parsed.threadId ||
      !parsed.chatJid.startsWith('sl:')
    ) {
      continue;
    }
    destinations.set(`${providerAccountId}:${parsed.chatJid}`, {
      name: route.conversationDisplayName ?? route.name,
      jid: parsed.chatJid,
      providerAccountId,
    });
  }
  return [...destinations.values()];
}

export async function sendNotification(input: {
  destination: string;
  text: string;
  destinations: readonly NotificationDestination[];
  sendMessage: (
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ) => Promise<void>;
}): Promise<{ sent: true; destination: NotificationDestination }> {
  const requested = input.destination.trim().replace(/^#/, '').toLowerCase();
  const matches = input.destinations.filter(
    (destination) =>
      destination.name.toLowerCase() === requested ||
      destination.jid.toLowerCase() === requested ||
      destination.jid.slice(3).toLowerCase() === requested,
  );
  if (matches.length !== 1) {
    const available = [...new Set(input.destinations.map((item) => `#${item.name}`))]
      .sort()
      .join(', ');
    throw new Error(
      `Requested destination "${input.destination}" is unavailable or ambiguous. Available channels: ${available || 'none'}.`,
    );
  }
  const destination = matches[0]!;
  await input.sendMessage(destination.jid, input.text, {
    providerAccountId: destination.providerAccountId,
  });
  return { sent: true, destination };
}

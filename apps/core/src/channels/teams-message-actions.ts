import type { OnMessageAction } from '../domain/types.js';
import type { TeamsInboundMessage } from './teams-types.js';
import { teamsConversationIdFromJid } from './teams-types.js';

export function readTeamsMessageAction(value: unknown): {
  kind: 'live_turn_stop';
  actionToken: string;
  targetJid: string;
  threadId?: string;
} | null {
  const data =
    typeof value === 'object' && value !== null && 'data' in value
      ? (value as { data?: unknown }).data
      : value;
  if (typeof data !== 'object' || data === null) return null;
  const payload = data as Record<string, unknown>;
  if (payload.action !== 'message_action') return null;
  if (payload.kind !== 'live_turn_stop') return null;
  if (
    typeof payload.actionToken !== 'string' ||
    typeof payload.targetJid !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'live_turn_stop',
    actionToken: payload.actionToken,
    targetJid: payload.targetJid,
    ...(typeof payload.threadId === 'string'
      ? { threadId: payload.threadId }
      : {}),
  };
}

export async function handleTeamsMessageAction(input: {
  message: TeamsInboundMessage;
  jid: string;
  userId: string;
  onMessageAction?: OnMessageAction;
  sendDenied: (conversationId: string | null, text: string) => Promise<void>;
}): Promise<boolean> {
  const payload = readTeamsMessageAction(input.message.value);
  if (!payload) return false;
  if (payload.targetJid !== input.jid) {
    await input.sendDenied(
      teamsConversationIdFromJid(input.jid),
      'This action belongs to a different chat.',
    );
    return true;
  }
  await input.onMessageAction?.({
    kind: 'live_turn_stop',
    conversationJid: input.jid,
    userId: input.userId,
    actionToken: payload.actionToken,
    ...(payload.threadId ? { threadId: payload.threadId } : {}),
  });
  return true;
}

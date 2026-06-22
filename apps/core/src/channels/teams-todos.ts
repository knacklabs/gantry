import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import { logger } from '../infrastructure/logging/logger.js';
import { agentTodoLines, buildTeamsAgentTodoCard } from './teams-cards.js';
import { sendTeamsTextMessage } from './teams-delivery.js';
import type { TeamsSdkClient } from './teams-types.js';
import { teamsConversationIdFromJid } from './teams-types.js';

export type TeamsTodoMessages = Map<
  string,
  { conversationId: string; messageId?: string }
>;

export async function renderTeamsAgentTodo(input: {
  sdkClient: TeamsSdkClient;
  pendingTodos: TeamsTodoMessages;
  jid: string;
  render: AgentTodoRender;
}): Promise<void> {
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) return;
  const card = buildTeamsAgentTodoCard(input.render);
  const todoKey = `${input.jid}:${input.render.threadId || ''}`;

  const existing = input.pendingTodos.get(todoKey);
  if (existing?.messageId && input.sdkClient.updateAdaptiveCard) {
    try {
      await input.sdkClient.updateAdaptiveCard({
        conversationId,
        messageId: existing.messageId,
        card,
        ...(input.render.threadId ? { threadId: input.render.threadId } : {}),
      });
      return;
    } catch (err) {
      logger.debug(
        { jid: input.jid, threadId: input.render.threadId, err },
        'Teams todo update failed; posting a fresh card',
      );
      input.pendingTodos.delete(todoKey);
    }
  }

  if (input.sdkClient.sendAdaptiveCard) {
    const result = await input.sdkClient.sendAdaptiveCard({
      conversationId,
      card,
      ...(input.render.threadId ? { threadId: input.render.threadId } : {}),
    });
    input.pendingTodos.set(todoKey, {
      conversationId,
      messageId: result.externalMessageId,
    });
    return;
  }

  const title = input.render.summary?.trim()
    ? input.render.summary.trim()
    : 'Plan';
  await sendTeamsTextMessage(
    input.sdkClient,
    conversationId,
    [`📋 ${title}`, ...agentTodoLines(input.render)].join('\n'),
    { ...(input.render.threadId ? { threadId: input.render.threadId } : {}) },
  );
}

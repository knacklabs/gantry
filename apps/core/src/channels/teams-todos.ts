import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import { logger } from '../infrastructure/logging/logger.js';
import { agentTodoLines, buildTeamsAgentTodoCard } from './teams-cards.js';
import {
  formatAgentTodoHeader,
  hasAgentTodoCardHeader,
} from './agent-todo-render.js';
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
}): Promise<boolean> {
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) return false;
  const card = buildTeamsAgentTodoCard(input.render, input.jid);
  const todoKey = `${input.jid}:${input.render.cardKind ?? 'todo'}:${input.render.threadId || ''}`;

  const existing = input.pendingTodos.get(todoKey);
  if (existing?.messageId && input.sdkClient.updateAdaptiveCard) {
    try {
      await input.sdkClient.updateAdaptiveCard({
        conversationId,
        messageId: existing.messageId,
        card,
        ...(input.render.threadId ? { threadId: input.render.threadId } : {}),
      });
      return true;
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
    return true;
  }

  const title = formatAgentTodoHeader(input.render);
  const heading = hasAgentTodoCardHeader(input.render) ? title : `📋 ${title}`;
  await sendTeamsTextMessage(
    input.sdkClient,
    conversationId,
    [heading, ...agentTodoLines(input.render)].join('\n'),
    { ...(input.render.threadId ? { threadId: input.render.threadId } : {}) },
  );
  return true;
}

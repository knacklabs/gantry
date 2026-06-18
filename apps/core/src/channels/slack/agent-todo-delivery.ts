import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { buildAgentTodoBlocks } from './agent-todo-blocks.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';

type SlackAppLike = {
  client: {
    chat: {
      update: (input: any) => Promise<unknown>;
      postMessage: (input: any) => Promise<unknown>;
    };
  };
};

export async function renderSlackAgentTodo(input: {
  app: SlackAppLike;
  jid: string;
  channelId: string;
  render: AgentTodoRender;
  todoKey: string;
  pendingTodos: Map<string, { channel: string; ts: string }>;
}): Promise<void> {
  const blocks = buildAgentTodoBlocks(input.render);
  const text = input.render.summary?.trim()
    ? `📋 ${input.render.summary.trim()}`
    : '📋 Plan';
  const threadTs = slackThreadTsFromThreadId(input.render.threadId);
  const existing = input.pendingTodos.get(input.todoKey);
  if (existing) {
    try {
      await input.app.client.chat.update({
        channel: existing.channel,
        ts: existing.ts,
        text,
        blocks: blocks as any,
      });
      return;
    } catch (err) {
      logger.debug(
        { jid: input.jid, threadId: input.render.threadId, err },
        'Slack todo update failed; sending a fresh message',
      );
      input.pendingTodos.delete(input.todoKey);
    }
  }
  try {
    const result = (await input.app.client.chat.postMessage({
      channel: input.channelId,
      text,
      blocks: blocks as any,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    })) as { ts?: string };
    if (result.ts) {
      input.pendingTodos.set(input.todoKey, {
        channel: input.channelId,
        ts: result.ts,
      });
    }
  } catch (err) {
    logger.warn({ jid: input.jid, err }, 'Failed to send Slack todo message');
  }
}

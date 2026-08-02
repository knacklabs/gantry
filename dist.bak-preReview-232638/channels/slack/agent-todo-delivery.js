import { logger } from '../../infrastructure/logging/logger.js';
import { formatAgentTodoHeader, hasAgentTodoCardHeader, } from '../agent-todo-render.js';
import { buildAgentTodoBlocks } from './agent-todo-blocks.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';
export async function renderSlackAgentTodo(input) {
    const blocks = buildAgentTodoBlocks(input.render, {
        providerAccountId: input.providerAccountId,
    });
    const title = formatAgentTodoHeader(input.render);
    const text = hasAgentTodoCardHeader(input.render) ? title : `📋 ${title}`;
    const threadTs = slackThreadTsFromThreadId(input.render.threadId);
    const existing = input.pendingTodos.get(input.todoKey);
    if (existing) {
        try {
            await input.app.client.chat.update({
                channel: existing.channel,
                ts: existing.ts,
                text,
                blocks: blocks,
            });
            return true;
        }
        catch (err) {
            logger.debug({ jid: input.jid, threadId: input.render.threadId, err }, 'Slack todo update failed; sending a fresh message');
            input.pendingTodos.delete(input.todoKey);
        }
    }
    try {
        const result = (await input.app.client.chat.postMessage({
            channel: input.channelId,
            text,
            blocks: blocks,
            ...(threadTs ? { thread_ts: threadTs } : {}),
        }));
        if (result.ts) {
            input.pendingTodos.set(input.todoKey, {
                channel: input.channelId,
                ts: result.ts,
            });
            return true;
        }
    }
    catch (err) {
        logger.warn({ jid: input.jid, err }, 'Failed to send Slack todo message');
    }
    return false;
}

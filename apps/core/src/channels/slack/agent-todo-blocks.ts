import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import {
  agentTodoStopActions,
  countCompletedAgentTodos,
  formatAgentTodoHeader,
  formatAgentTodoLine,
  hasAgentTodoCardHeader,
} from '../agent-todo-render.js';
import { truncateSlackText } from './channel-user-question-utils.js';
import { slackMessageActionBlocks } from './message-action-affordances.js';

type SlackBlock = Record<string, unknown>;

// Slack section `mrkdwn` text caps at 3000 chars; keep a margin for the
// "(N more)" tail so a long plan never trips the Block Kit limit.
const AGENT_TODO_SECTION_MAX = 2900;

function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build Block Kit blocks for an agent todo/plan: a header, a single mrkdwn
 * section listing each item with a status emoji, and a "{done}/{total} done"
 * context line. Long lists collapse to a trailing "… (N more)" so the section
 * stays within Slack's text limit. Used for both the initial post and every
 * in-place `chat.update`.
 */
export function buildAgentTodoBlocks(
  render: AgentTodoRender,
  options: { providerAccountId?: string } = {},
): SlackBlock[] {
  const title = formatAgentTodoHeader(render);
  const heading = hasAgentTodoCardHeader(render) ? title : `📋 ${title}`;
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let index = 0; index < render.items.length; index += 1) {
    const item = render.items[index];
    const line = formatAgentTodoLine(item, escapeSlackMrkdwn);
    if (used + line.length + 1 > AGENT_TODO_SECTION_MAX) {
      dropped = render.items.length - index;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped > 0) lines.push(`… (${dropped} more)`);
  const done = countCompletedAgentTodos(render);
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncateSlackText(heading, 150),
        emoji: true,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') || '_No items_' },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${done}/${render.items.length} done` },
      ],
    },
  ];
  const actionBlocks = slackMessageActionBlocks(
    '',
    agentTodoStopActions(render),
    { providerAccountId: options.providerAccountId },
  )?.filter((block) => block.type === 'actions');
  return actionBlocks ? [...blocks, ...actionBlocks] : blocks;
}

import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
type SlackBlock = Record<string, unknown>;
/**
 * Build Block Kit blocks for an agent todo/plan: a header, a single mrkdwn
 * section listing each item with a status emoji, and a "{done}/{total} done"
 * context line. Long lists collapse to a trailing "… (N more)" so the section
 * stays within Slack's text limit. Used for both the initial post and every
 * in-place `chat.update`.
 */
export declare function buildAgentTodoBlocks(render: AgentTodoRender, options?: {
    providerAccountId?: string;
}): SlackBlock[];
export {};

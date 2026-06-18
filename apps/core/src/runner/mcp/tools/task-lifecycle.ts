import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { nowIso } from '../../../shared/time/datetime.js';
import {
  chatJid,
  jobRunId,
  jobRunLeaseFencingVersion,
  jobRunLeaseToken,
  TASKS_DIR,
  threadId,
} from '../context.js';
import { formatTaskFailureLines } from '../formatting.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import { makeIpcId } from '../ipc-ids.js';

const TASK_TOOL_TIMEOUT_MS = 20_000;

const todoItemSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(240),
  status: z.enum(['pending', 'inProgress', 'completed', 'blocked']),
  note: z.string().max(500).optional(),
});

async function submitTaskLifecycleRequest(input: {
  type: string;
  payload: Record<string, unknown>;
  timeoutMessage: string;
  fallbackError: string;
}) {
  const taskId = makeIpcId(input.type.replaceAll('_', '-'));
  writeIpcFile(TASKS_DIR, {
    type: input.type,
    taskId,
    runHandle: process.env.GANTRY_AGENT_RUN_HANDLE || undefined,
    ...(jobRunId ? { runId: jobRunId } : {}),
    ...(jobRunLeaseToken ? { runLeaseToken: jobRunLeaseToken } : {}),
    ...(jobRunLeaseFencingVersion
      ? { runLeaseFencingVersion: Number(jobRunLeaseFencingVersion) }
      : {}),
    payload: input.payload,
    targetJid: chatJid,
    chatJid,
    authThreadId: threadId,
    timestamp: nowIso(),
  });
  const response = await waitForTaskResponse(taskId, TASK_TOOL_TIMEOUT_MS);
  if (!response) {
    return {
      content: [{ type: 'text' as const, text: input.timeoutMessage }],
      isError: true,
    };
  }
  if (!response.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text: formatTaskFailureLines(response, input.fallbackError).join(
            '\n',
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: formatSuccessfulTaskResponse(response),
      },
    ],
  };
}

function formatSuccessfulTaskResponse(response: {
  message?: string;
  data?: unknown;
}): string {
  const message = response.message || 'Done.';
  if (response.data === undefined) return message;
  return `${message}\n${JSON.stringify(response.data, null, 2)}`;
}

export function registerTaskLifecycleTools(server: McpServer): void {
  server.tool(
    'todo_update',
    'Publish and maintain a visible multi-step plan for this run, updating item status as work progresses; it renders as one live, in-place list per channel. This is display-only planning state only; it cannot grant tools, create permissions, change settings, or trigger work.',
    {
      summary: z.string().max(500).optional(),
      items: z.array(todoItemSchema).min(1).max(50),
    },
    async (args) =>
      submitTaskLifecycleRequest({
        type: 'todo_update',
        payload: {
          ...(args.summary ? { summary: args.summary } : {}),
          items: args.items,
        },
        timeoutMessage: 'Plan update timed out.',
        fallbackError: 'Plan update failed.',
      }),
  );
}

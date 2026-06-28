import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { nowIso } from '../../../shared/time/datetime.js';
import {
  chatJid,
  jobRunId,
  jobId,
  jobRunLeaseFencingVersion,
  jobRunLeaseToken,
  TASKS_DIR,
  agentId,
  appId,
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
    ...(appId ? { appId } : {}),
    ...(agentId ? { agentId } : {}),
    runHandle: process.env.GANTRY_AGENT_RUN_HANDLE || undefined,
    ...(jobId ? { jobId } : {}),
    ...(jobRunId ? { runId: jobRunId } : {}),
    ...(process.env.GANTRY_PARENT_TASK_ID
      ? { parentTaskId: process.env.GANTRY_PARENT_TASK_ID }
      : {}),
    ...(process.env.GANTRY_LIVE_STOP_ACTION_TOKEN
      ? { liveStopActionToken: process.env.GANTRY_LIVE_STOP_ACTION_TOKEN }
      : {}),
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
    'async_run_command',
    'Start an approved shell command as a durable background task. Use only for long-running commands that should continue while you inspect status with task_get or task_list. The host enforces selected RunCommand(...) capability rules before it creates the task.',
    {
      command: z.string().min(1).max(20_000),
    },
    async (args) =>
      submitTaskLifecycleRequest({
        type: 'async_run_command',
        payload: { command: args.command },
        timeoutMessage: 'Async command start timed out.',
        fallbackError: 'Async command start failed.',
      }),
  );

  server.tool(
    'task_get',
    'Read the current status and terminal receipt for one durable async task created by this agent in this conversation.',
    {
      taskId: z.string().min(1).max(160),
    },
    async (args) =>
      submitTaskLifecycleRequest({
        type: 'task_get',
        payload: { taskId: args.taskId },
        timeoutMessage: 'Task status read timed out.',
        fallbackError: 'Task status read failed.',
      }),
  );

  server.tool(
    'task_list',
    'List recent durable async tasks created by this agent in this conversation.',
    {},
    async () =>
      submitTaskLifecycleRequest({
        type: 'task_list',
        payload: {},
        timeoutMessage: 'Task list timed out.',
        fallbackError: 'Task list failed.',
      }),
  );

  server.tool(
    'task_cancel',
    'Cancel one running durable async task created by this agent in this conversation. Cancellation aborts the active command when it is still running.',
    {
      taskId: z.string().min(1).max(160),
    },
    async (args) =>
      submitTaskLifecycleRequest({
        type: 'task_cancel',
        payload: { taskId: args.taskId },
        timeoutMessage: 'Task cancel timed out.',
        fallbackError: 'Task cancel failed.',
      }),
  );

  server.tool(
    'delegate_task',
    'Start a durable async child agent run. Use task_get/task_list to inspect it and task_message to steer it while it is running.',
    {
      objective: z.string().min(1).max(10_000),
      context: z.string().max(20_000).optional(),
      expectedOutput: z.string().max(2_000).optional(),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(30 * 60_000)
        .optional(),
    },
    async (args) =>
      submitTaskLifecycleRequest({
        type: 'delegate_task',
        payload: args,
        timeoutMessage: 'Delegated task start timed out.',
        fallbackError: 'Delegated task start failed.',
      }),
  );

  server.tool(
    'task_message',
    'Send a steering message to a running delegated async task. Terminal tasks and async command tasks reject steering messages.',
    {
      taskId: z.string().min(1).max(160),
      message: z.string().min(1).max(10_000),
    },
    async (args) =>
      submitTaskLifecycleRequest({
        type: 'task_message',
        payload: { taskId: args.taskId, message: args.message },
        timeoutMessage: 'Task message timed out.',
        fallbackError: 'Task message failed.',
      }),
  );

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

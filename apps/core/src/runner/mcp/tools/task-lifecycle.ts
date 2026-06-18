import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { nowIso } from '../../../shared/time/datetime.js';
import {
  chatJid,
  currentConfiguredAllowedTools,
  jobRunId,
  jobRunLeaseFencingVersion,
  jobRunLeaseToken,
  TASKS_DIR,
  threadId,
} from '../context.js';
import { formatTaskFailureLines } from '../formatting.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import { makeIpcId } from '../ipc-ids.js';

const AGENT_DELEGATION_RULE = 'AgentDelegation';
const TASK_TOOL_TIMEOUT_MS = 20_000;

const todoItemSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(240),
  status: z.enum(['pending', 'inProgress', 'completed', 'blocked']),
  taskId: z.string().min(1).max(128).optional(),
  note: z.string().max(500).optional(),
});

function hasAgentDelegation(): boolean {
  return currentConfiguredAllowedTools().some(
    (rule) => rule.trim() === AGENT_DELEGATION_RULE,
  );
}

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

function delegationDeniedResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'Agent delegation is not approved for this agent.',
      },
    ],
    isError: true,
  };
}

function delegationUnavailableResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'Agent delegation is unavailable until Gantry has a delegated-task executor configured.',
      },
    ],
    isError: true,
  };
}

export function registerTaskLifecycleTools(server: McpServer): void {
  server.tool(
    'todo_update',
    'Publish and maintain a visible multi-step plan for this run, updating item status as work progresses; it renders as one live, in-place list per channel. This is audited, display-only planning state only; it cannot grant tools, create permissions, change settings, or trigger work.',
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

  server.tool(
    'delegate_task',
    'Request bounded Gantry-owned delegated work when the AgentDelegation capability is selected. Only report that work started when the tool returns a taskId; if it reports unavailable, continue without delegation or request setup. Provider task ids are never public authority.',
    {
      title: z.string().min(1).max(160),
      task: z.string().min(1).max(12000),
      expectedOutput: z.string().min(1).max(4000),
      context: z.string().max(12000).optional(),
      timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    },
    async () => {
      if (!hasAgentDelegation()) return delegationDeniedResult();
      return delegationUnavailableResult();
    },
  );

  server.tool(
    'task_get',
    'Check the status and result of one Gantry-owned delegated task by taskId within the current run/conversation scope.',
    {
      taskId: z.string().min(1).max(160),
    },
    async (args) => {
      if (!hasAgentDelegation()) return delegationDeniedResult();
      return submitTaskLifecycleRequest({
        type: 'task_get',
        payload: { taskId: args.taskId },
        timeoutMessage: 'Delegated task lookup timed out.',
        fallbackError: 'Delegated task lookup failed.',
      });
    },
  );

  server.tool(
    'task_cancel',
    'Cancel one owned non-terminal delegated task by Gantry taskId. Gantry marks it cancelled before any best-effort provider cancellation.',
    {
      taskId: z.string().min(1).max(160),
      reason: z.string().max(500).optional(),
    },
    async (args) => {
      if (!hasAgentDelegation()) return delegationDeniedResult();
      return submitTaskLifecycleRequest({
        type: 'task_cancel',
        payload: {
          taskId: args.taskId,
          ...(args.reason ? { reason: args.reason } : {}),
        },
        timeoutMessage: 'Delegated task cancellation timed out.',
        fallbackError: 'Delegated task cancellation failed.',
      });
    },
  );
}

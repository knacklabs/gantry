import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { chatJid, TASKS_DIR } from '../context.js';
import { makeIpcId } from '../ipc-ids.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';

const CANVAS_TASK_TIMEOUT_MS = 120_000;
const canvasOperation = z.enum([
  'insert_at_start',
  'insert_at_end',
  'insert_before',
  'insert_after',
  'replace_section',
  'delete_section',
  'replace_all',
]);

export function registerCanvasTools(server: McpServer): void {
  server.tool(
    'canvas_create',
    'Create a Slack canvas in this conversation. The host derives the Slack channel; never supply a raw channel or canvas id. Returns separate opaque read and update handles. Free Slack workspaces reuse the channel canvas when one already exists.',
    {
      // Title length is validated at the IPC boundary (code points).
      title: z.string().optional(),
      markdown: z.string().optional(),
    },
    async ({ title, markdown }) =>
      canvasToolResult(
        await requestCanvasTask('canvas_create', {
          ...(title !== undefined ? { title } : {}),
          ...(markdown !== undefined ? { markdown } : {}),
        }),
      ),
  );

  server.tool(
    'canvas_read',
    'Read a Slack canvas using an opaque canvas_read_handle issued in this conversation. Shared canvases are read-only. The host returns bounded text and fresh section handles; missing Slack scopes produce reinstall guidance.',
    {
      canvas_handle: z.string().min(1),
    },
    async ({ canvas_handle }) =>
      canvasToolResult(
        await requestCanvasTask('canvas_read', { canvas_handle }),
      ),
  );

  server.tool(
    'canvas_update',
    'Update a Slack canvas using only a canvas_update_handle issued for this conversation. Slack is last-write-wins: Gantry serializes its own edits per canvas, but cannot prevent concurrent human edits. Section operations require a fresh host-issued section handle; replace_all also requires confirm_replace_all=true plus the single-use replace_all_preflight_id issued by the preceding rejected attempt.',
    {
      canvas_handle: z.string().min(1),
      section_handle: z.string().min(1).optional(),
      operation: canvasOperation,
      markdown: z.string().optional(),
      confirm_replace_all: z.boolean().optional(),
      replace_all_preflight_id: z.string().optional(),
    },
    async (input) =>
      canvasToolResult(await requestCanvasTask('canvas_update', input)),
  );
}

export function canvasTaskRequest(
  type: 'canvas_create' | 'canvas_read' | 'canvas_update',
  taskId: string,
  payload: Record<string, unknown>,
) {
  return {
    type,
    taskId,
    chatJid,
    targetJid: chatJid,
    payload,
  };
}

async function requestCanvasTask(
  type: 'canvas_create' | 'canvas_read' | 'canvas_update',
  payload: Record<string, unknown>,
) {
  const taskId = makeIpcId(type);
  writeIpcFile(TASKS_DIR, canvasTaskRequest(type, taskId, payload));
  return waitForTaskResponse(taskId, CANVAS_TASK_TIMEOUT_MS);
}

function canvasToolResult(
  response: Awaited<ReturnType<typeof waitForTaskResponse>>,
) {
  if (!response) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Slack canvas request timed out before the host responded.',
        },
      ],
      isError: true,
    };
  }
  if (!response.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text: response.error || 'The host rejected the Slack canvas request.',
        },
      ],
      isError: true,
    };
  }
  const data =
    response.data &&
    typeof response.data === 'object' &&
    !Array.isArray(response.data)
      ? response.data
      : {};
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

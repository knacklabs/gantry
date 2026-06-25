import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { nowIso } from '../../../shared/time/datetime.js';
import {
  SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
  UNREVIEWED_DISCOVERY_GUIDANCE,
} from '../../../shared/capability-guidance.js';
import {
  capabilityStatusText,
  chatJid,
  jobId,
  jobRunId,
  jobRunLeaseFencingVersion,
  jobRunLeaseToken,
  lockedAccessPreset,
  TASKS_DIR,
  threadId,
} from '../context.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import { makeIpcId } from '../ipc-ids.js';
import { MCP_PROXY_WAIT_MS } from './service-constants.js';
import {
  formatMcpCallToolResponse,
  formatMcpDescribeToolResponse,
  formatMcpListToolsResponse,
} from './service-formatters.js';

export function registerMcpProxyTools(server: McpServer): void {
  server.tool(
    'mcp_list_tools',
    lockedAccessPreset
      ? 'List tools from MCP server sources connected to this agent.'
      : 'Refresh tools from MCP server sources connected to this agent. This is source inventory only; use reviewed action capabilities as the authority.',
    {
      serverName: z
        .string()
        .optional()
        .describe('Optional connected MCP server name to inspect'),
      query: z
        .string()
        .optional()
        .describe('Optional text query over MCP server, tool, and description'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum tools to return, up to 50'),
      cursor: z
        .string()
        .optional()
        .describe('Cursor from a previous mcp_list_tools response'),
    },
    async (args) => {
      const taskId = makeIpcId('mcp-list-tools');
      writeIpcFile(TASKS_DIR, {
        type: 'mcp_list_tools',
        taskId,
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: {
          serverName: args.serverName,
          query: args.query,
          limit: args.limit,
          cursor: args.cursor,
        },
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, MCP_PROXY_WAIT_MS);
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: response?.error || 'MCP tool listing failed.',
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: (lockedAccessPreset
              ? [
                  formatMcpListToolsResponse(response.data, {
                    includeReviewGuidance: false,
                  }),
                  capabilityStatusText(),
                ]
              : [
                  formatMcpListToolsResponse(response.data),
                  SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
                  UNREVIEWED_DISCOVERY_GUIDANCE,
                  capabilityStatusText(),
                ]
            ).join('\n\n'),
          },
        ],
      };
    },
  );

  server.tool(
    'mcp_describe_tool',
    lockedAccessPreset
      ? 'Describe one tool from an MCP server source connected to this agent.'
      : 'Fetch untrusted schema/details for one tool from a connected MCP source. This is source inventory only; mcp_call_tool still rechecks reviewed current-run action capability.',
    {
      serverName: z.string().describe('Connected MCP server name to inspect'),
      toolName: z
        .string()
        .describe('Raw MCP tool name without the mcp__server__ prefix'),
    },
    async (args) => {
      const taskId = makeIpcId('mcp-describe-tool');
      writeIpcFile(TASKS_DIR, {
        type: 'mcp_describe_tool',
        taskId,
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: {
          serverName: args.serverName,
          toolName: args.toolName,
        },
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, MCP_PROXY_WAIT_MS);
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: response?.error || 'MCP tool detail failed.',
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: (lockedAccessPreset
              ? [
                  formatMcpDescribeToolResponse(response.data),
                  capabilityStatusText(),
                ]
              : [
                  formatMcpDescribeToolResponse(response.data),
                  SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
                  UNREVIEWED_DISCOVERY_GUIDANCE,
                  capabilityStatusText(),
                ]
            ).join('\n\n'),
          },
        ],
      };
    },
  );

  server.tool(
    'mcp_call_tool',
    lockedAccessPreset
      ? 'Call a tool from an MCP server source connected to this agent. Use serverName and the raw tool name from mcp_list_tools.'
      : 'Call a raw MCP source tool only when the requested action is covered by reviewed current-run capability access. Prefer the reviewed action capability as the product contract; do not call direct third-party mcp__server__tool names.',
    {
      serverName: z.string().describe('Connected MCP server name'),
      toolName: z
        .string()
        .describe('Raw MCP tool name without the mcp__server__ prefix'),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('JSON object arguments for the MCP tool'),
    },
    async (args) => {
      const taskId = makeIpcId('mcp-call-tool');
      writeIpcFile(TASKS_DIR, {
        type: 'mcp_call_tool',
        taskId,
        runHandle: process.env.GANTRY_AGENT_RUN_HANDLE || undefined,
        ...(jobRunId ? { runId: jobRunId } : {}),
        ...(jobRunLeaseToken ? { runLeaseToken: jobRunLeaseToken } : {}),
        ...(jobRunLeaseFencingVersion !== undefined
          ? { runLeaseFencingVersion: Number(jobRunLeaseFencingVersion) }
          : {}),
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: {
          serverName: args.serverName,
          toolName: args.toolName,
          arguments: args.arguments ?? {},
        },
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, MCP_PROXY_WAIT_MS);
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: response?.error || 'MCP tool call failed.',
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: formatMcpCallToolResponse(response.data),
          },
        ],
      };
    },
  );

  server.tool(
    'async_mcp_call',
    lockedAccessPreset
      ? 'Start a background call to a tool from an MCP server source connected to this agent. Use task_get or task_list for status.'
      : 'Start a background MCP source tool call only when the requested action is covered by reviewed current-run capability access. Use task_get or task_list for status; do not poll in a tight loop.',
    {
      serverName: z.string().describe('Connected MCP server name'),
      toolName: z
        .string()
        .describe('Raw MCP tool name without the mcp__server__ prefix'),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('JSON object arguments for the MCP tool'),
    },
    async (args) => {
      const taskId = makeIpcId('async-mcp-call');
      writeIpcFile(TASKS_DIR, {
        type: 'async_mcp_call',
        taskId,
        runHandle: process.env.GANTRY_AGENT_RUN_HANDLE || undefined,
        ...(jobId ? { jobId } : {}),
        ...(jobRunId ? { runId: jobRunId } : {}),
        ...(process.env.GANTRY_PARENT_TASK_ID
          ? { parentTaskId: process.env.GANTRY_PARENT_TASK_ID }
          : {}),
        ...(jobRunLeaseToken ? { runLeaseToken: jobRunLeaseToken } : {}),
        ...(jobRunLeaseFencingVersion !== undefined
          ? { runLeaseFencingVersion: Number(jobRunLeaseFencingVersion) }
          : {}),
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: {
          serverName: args.serverName,
          toolName: args.toolName,
          arguments: args.arguments ?? {},
        },
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, MCP_PROXY_WAIT_MS);
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: response?.error || 'Async MCP tool call failed.',
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `${response.message || 'Async MCP task started.'}\n${JSON.stringify(response.data)}`,
          },
        ],
      };
    },
  );
}

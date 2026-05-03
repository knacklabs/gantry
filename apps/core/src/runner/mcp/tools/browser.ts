import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatBrowserToolResponse } from '../formatting.js';
import { requestBrowserAction } from '../ipc.js';

function formatBrowserFailure(action: string, error: string | undefined) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Browser ${action} failed: ${error || 'unknown error'}`,
      },
    ],
    isError: true,
  };
}

export function registerBrowserTools(server: McpServer): void {
  server.tool(
    'browser_profile_list',
    'List available browser profiles and metadata.',
    {},
    async () => {
      const response = await requestBrowserAction('browser_profile_list', {});
      if (!response.ok) {
        return formatBrowserFailure('profile list', response.error);
      }
      return {
        content: [
          { type: 'text' as const, text: formatBrowserToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'browser_launch',
    'Launch, recover, or reuse this conversation scoped Chrome browser profile. Optional keep_alive_ms extends the explicit hold.',
    {
      headless: z.boolean().optional(),
      keep_alive_ms: z.number().optional(),
    },
    async (args) => {
      const response = await requestBrowserAction('browser_launch', args);
      if (!response.ok) {
        return formatBrowserFailure('launch', response.error);
      }
      return {
        content: [
          { type: 'text' as const, text: formatBrowserToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'browser_close',
    'Close this conversation scoped Chrome browser profile.',
    {},
    async (args) => {
      const response = await requestBrowserAction('browser_close', args);
      if (!response.ok) {
        return formatBrowserFailure('close', response.error);
      }
      return {
        content: [
          { type: 'text' as const, text: formatBrowserToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'browser_status',
    'Get status for this conversation scoped Chrome browser profile.',
    {},
    async (args) => {
      const response = await requestBrowserAction('browser_status', args);
      if (!response.ok) {
        return formatBrowserFailure('status', response.error);
      }

      return {
        content: [
          { type: 'text' as const, text: formatBrowserToolResponse(response) },
        ],
      };
    },
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateBrowserCdpResponse } from '../browser-cdp-health.js';
import { formatBrowserToolResponse } from '../formatting.js';
import { requestBrowserAction } from '../ipc.js';

function formatBrowserFailure(action: string, error?: string): string {
  return `Browser ${action} failed: ${error || 'unknown error'}`;
}

export function registerBrowserTools(server: McpServer): void {
  server.tool(
    'browser_profile_list',
    'List available browser profiles and metadata.',
    {},
    async () => {
      const response = await requestBrowserAction('browser_profile_list', {});
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatBrowserFailure('profile list', response.error),
            },
          ],
          isError: true,
        };
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
    'Launch or reuse the shared Chrome browser session (profile: myclaw).',
    {
      profile_name: z.string().optional().default('myclaw'),
      headless: z.boolean().optional(),
      cdp_port: z.number().optional(),
      keep_alive_ms: z.number().optional(),
    },
    async (args) => {
      const response = await validateBrowserCdpResponse(
        await requestBrowserAction('browser_launch', args),
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatBrowserFailure('launch', response.error),
            },
          ],
          isError: true,
        };
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
    'Close the shared Chrome browser session (profile: myclaw).',
    {
      profile_name: z.string().optional().default('myclaw'),
    },
    async (args) => {
      const response = await requestBrowserAction('browser_close', args);
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatBrowserFailure('close', response.error),
            },
          ],
          isError: true,
        };
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
    'Get status for the shared Chrome browser session (profile: myclaw).',
    {
      profile_name: z.string().optional().default('myclaw'),
    },
    async (args) => {
      const response = await validateBrowserCdpResponse(
        await requestBrowserAction('browser_status', args),
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatBrowserFailure('status', response.error),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: 'text' as const, text: formatBrowserToolResponse(response) },
        ],
      };
    },
  );
}

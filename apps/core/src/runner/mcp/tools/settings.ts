import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nowIso, nowMs } from '../../../infrastructure/time/datetime.js';
import { chatJid, TASKS_DIR, threadId } from '../context.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import type { AdminMcpToolName } from '../../../shared/admin-mcp-tools.js';

const SETTINGS_APPROVAL_WAIT_MS = 5 * 60 * 1000;

export function registerSettingsTools(
  server: McpServer,
  options: { isAdminToolEnabled: (toolName: AdminMcpToolName) => boolean },
): void {
  if (options.isAdminToolEnabled('settings_desired_state')) {
    server.tool(
      'settings_desired_state',
      'Read the current local settings.yaml desired state before requesting local MyClaw configuration changes. Requires the selected agent capability tool:mcp__myclaw__settings_desired_state.',
      {},
      async () => {
        const taskId = `settings-desired-state-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'settings_desired_state',
          taskId,
          targetJid: chatJid,
          chatJid,
          authThreadId: threadId,
          timestamp: nowIso(),
        });
        const response = await waitForTaskResponse(taskId, 20_000);
        if (!response?.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  response?.error || 'Settings desired-state lookup failed.',
              },
            ],
            isError: true,
          };
        }
        const data =
          response.data && typeof response.data === 'object'
            ? (response.data as { yaml?: unknown; revision?: unknown })
            : {};
        const revision = String(data.revision || '');
        return {
          content: [
            {
              type: 'text' as const,
              text: revision
                ? `revision: ${revision}\n\n${String(data.yaml || response.message || '')}`
                : String(data.yaml || response.message || ''),
            },
          ],
        };
      },
    );
  }

  if (options.isAdminToolEnabled('request_settings_update')) {
    server.tool(
      'request_settings_update',
      'Request a reviewed update to local settings.yaml. Requires the selected agent capability tool:mcp__myclaw__request_settings_update.',
      {
        replacementYaml: z
          .string()
          .describe('Complete replacement settings.yaml content'),
        expectedRevision: z
          .string()
          .describe(
            'Revision returned by settings_desired_state for lost-update protection',
          ),
        reason: z.string().describe('Why this settings change is needed'),
      },
      async (args) => {
        const taskId = `settings-update-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'request_settings_update',
          taskId,
          targetJid: chatJid,
          chatJid,
          authThreadId: threadId,
          payload: {
            replacementYaml: args.replacementYaml,
            expectedRevision: args.expectedRevision,
            reason: args.reason,
          },
          timestamp: nowIso(),
        });
        const response = await waitForTaskResponse(
          taskId,
          SETTINGS_APPROVAL_WAIT_MS,
        );
        if (!response?.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: response?.error || 'Settings update was not applied.',
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text:
                response.message ||
                'Settings update approved and written. Safe changes will reload; restart may be required for topology changes.',
            },
          ],
        };
      },
    );
  }
}

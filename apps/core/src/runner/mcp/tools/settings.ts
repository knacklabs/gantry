import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nowIso } from '../../../shared/time/datetime.js';
import { chatJid, TASKS_DIR, threadId } from '../context.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import type { AdminMcpToolName } from '../../../shared/admin-mcp-tools.js';
import { humanizeTechnicalIdentifier } from '../../../shared/user-visible-messages.js';
import {
  formatGuidedActionPreview,
  type GuidedActionPreview,
} from '../../../application/guided-actions/guided-action-service.js';
import { makeIpcId } from '../ipc-ids.js';

const SETTINGS_APPROVAL_WAIT_MS = 5 * 60 * 1000;

export function registerSettingsTools(
  server: McpServer,
  options: { isAdminToolEnabled: (toolName: AdminMcpToolName) => boolean },
): void {
  server.tool(
    'settings_desired_state',
    'Read the current local settings.yaml desired state before requesting local Gantry configuration changes. Requires selected agent tool grant mcp__gantry__settings_desired_state.',
    {},
    async () => {
      if (!options.isAdminToolEnabled('settings_desired_state')) {
        return adminToolUnavailable('settings_desired_state');
      }
      const taskId = makeIpcId('settings-desired-state');
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
              text: response?.error || 'Settings desired-state lookup failed.',
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

  server.tool(
    'guided_action_preview',
    'Preview the current control-plane guided action (next action) before requesting any change. Read-only. Requires selected agent tool grant mcp__gantry__guided_action_preview.',
    {},
    async () => {
      if (!options.isAdminToolEnabled('guided_action_preview')) {
        return adminToolUnavailable('guided_action_preview');
      }
      const taskId = makeIpcId('guided-action-preview');
      writeIpcFile(TASKS_DIR, {
        type: 'guided_action_preview',
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
              text: response?.error || 'Guided action preview lookup failed.',
            },
          ],
          isError: true,
        };
      }
      const preview =
        response.data && typeof response.data === 'object'
          ? (response.data as GuidedActionPreview)
          : undefined;
      return {
        content: [
          {
            type: 'text' as const,
            text: preview
              ? formatGuidedActionPreview(preview)
              : response.message || 'No guided action preview available.',
          },
        ],
      };
    },
  );

  server.tool(
    'request_settings_update',
    'Request a reviewed update to local settings.yaml. Requires selected agent tool grant mcp__gantry__request_settings_update.',
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
      if (!options.isAdminToolEnabled('request_settings_update')) {
        return adminToolUnavailable('request_settings_update');
      }
      const taskId = makeIpcId('settings-update');
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

function adminToolUnavailable(toolName: AdminMcpToolName): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const fullName = `mcp__gantry__${toolName}`;
  return {
    content: [
      {
        type: 'text',
        text: [
          `${humanizeTechnicalIdentifier(fullName)} is not approved for this agent yet.`,
          `Ask a configured conversation approver to approve ${toolName}, then choose persistent access. Details: ${fullName}.`,
        ].join(' '),
      },
    ],
    isError: true,
  };
}

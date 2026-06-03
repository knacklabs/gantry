import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nowIso } from '../../../shared/time/datetime.js';
import {
  ADMIN_MCP_TOOL_NAMES,
  type AdminMcpToolName,
} from '../../../shared/admin-mcp-tools.js';
import {
  chatJid,
  configuredAllowedTools,
  currentEnabledAdminMcpTools,
  IPC_DIR,
  attachedMcpSourceIds,
  selectedSkillDisplays,
  attachedSkillSourceIds,
  TASKS_DIR,
  threadId,
} from '../context.js';
import { humanizeTechnicalIdentifier } from '../../../shared/user-visible-messages.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import { makeIpcId } from '../ipc-ids.js';
import { formatTaskFailureLines } from '../formatting.js';
import { readLiveToolRules } from '../../../shared/live-tool-rules.js';

export function registerAdminPermissionTools(
  server: McpServer,
  options: {
    isAdminToolEnabled: (toolName: AdminMcpToolName) => boolean;
  },
): void {
  server.tool(
    'admin_permission_list',
    'List local permission and capability selection signals visible to this runner. Read-only and available without an admin grant.',
    {},
    async () => {
      return {
        content: [
          {
            type: 'text' as const,
            text: formatAdminPermissionList(),
          },
        ],
      };
    },
  );

  server.tool(
    'admin_permission_revoke',
    'Revoke one current-agent persistent tool grant. Requires selected agent tool grant mcp__gantry__admin_permission_revoke.',
    {
      tool_name: z
        .string()
        .optional()
        .describe('Optional public tool rule or mcp__gantry__ tool name.'),
      tool_id: z
        .string()
        .optional()
        .describe('Optional durable tool catalog id, such as tool:Browser.'),
      reason: z.string().describe('Why the grant should be revoked.'),
    },
    async (args) => {
      if (!options.isAdminToolEnabled('admin_permission_revoke')) {
        return adminToolUnavailable('admin_permission_revoke');
      }
      const taskId = makeIpcId('admin-permission-revoke');
      writeIpcFile(TASKS_DIR, {
        type: 'admin_permission_revoke',
        taskId,
        runHandle: process.env.GANTRY_AGENT_RUN_HANDLE || undefined,
        payload: {
          toolName: args.tool_name,
          toolId: args.tool_id,
          reason: args.reason,
        },
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            { type: 'text' as const, text: 'Permission revoke timed out.' },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Permission revoke was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Permission grant revoked.',
          },
        ],
      };
    },
  );
}

function formatAdminPermissionList(): string {
  const enabledAdminTools = currentEnabledAdminMcpTools();
  const visibleToolRules = [
    ...new Set([
      ...configuredAllowedTools,
      ...readLiveToolRules({
        ipcDir: IPC_DIR,
        runHandle: process.env.GANTRY_AGENT_RUN_HANDLE,
      }),
    ]),
  ];
  const selectedSkillStatusItems =
    selectedSkillDisplays.length > 0
      ? selectedSkillDisplays
      : attachedSkillSourceIds;
  return [
    'Admin permission inventory (read-only runner view):',
    ...ADMIN_MCP_TOOL_NAMES.map((toolName) => {
      const status =
        toolName === 'admin_permission_list'
          ? 'available (read-only)'
          : enabledAdminTools.has(toolName)
            ? 'approved'
            : 'not approved';
      return `- mcp__gantry__${toolName}: ${status}`;
    }),
    '',
    'Visible tool rules:',
    ...(visibleToolRules.length > 0
      ? visibleToolRules
          .slice()
          .sort()
          .map((tool) => `- ${tool}`)
      : ['- none visible to this runner']),
    '',
    'Installed skills ready for this agent:',
    ...(selectedSkillStatusItems.length > 0
      ? selectedSkillStatusItems
          .slice()
          .sort()
          .map((skill) => `- ${skill}`)
      : ['- none installed yet']),
    '',
    'Connected MCP services ready for this agent:',
    ...(attachedMcpSourceIds.length > 0
      ? attachedMcpSourceIds
          .slice()
          .sort()
          .map((server) => `- ${server}`)
      : ['- none connected yet']),
    '',
    'Mutation status: admin_permission_revoke is available when selected for this agent and revokes current-agent grants only.',
  ].join('\n');
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

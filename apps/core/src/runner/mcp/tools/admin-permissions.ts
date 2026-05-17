import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ADMIN_MCP_TOOL_NAMES,
  type AdminMcpToolName,
} from '../../../shared/admin-mcp-tools.js';
import {
  configuredAllowedTools,
  currentEnabledAdminMcpTools,
  selectedMcpServerIds,
  selectedSkillIds,
} from '../context.js';

export function registerAdminPermissionTools(
  server: McpServer,
  options: {
    isAdminToolEnabled: (toolName: AdminMcpToolName) => boolean;
  },
): void {
  server.tool(
    'admin_permission_list',
    'List local permission and capability selection signals visible to this runner. Requires selected agent tool grant mcp__myclaw__admin_permission_list.',
    {},
    async () => {
      if (!options.isAdminToolEnabled('admin_permission_list')) {
        return adminToolUnavailable('admin_permission_list');
      }
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
    'Scaffold for revoking an agent permission grant. This fails closed until the host exposes a durable revocation service.',
    {
      tool_name: z
        .string()
        .optional()
        .describe('Optional public tool rule or mcp__myclaw__ tool name.'),
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
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              'Permission revoke is not available from runner MCP yet.',
              'No permission, settings.yaml entry, Postgres binding, or live run rule was changed.',
              'Host durable revocation needs an application service that updates settings.yaml and the Postgres projection together before this tool can mutate state.',
              `Requested target: ${args.tool_id ?? args.tool_name ?? '(unspecified)'}.`,
            ].join(' '),
          },
        ],
        isError: true,
      };
    },
  );
}

function formatAdminPermissionList(): string {
  const enabledAdminTools = currentEnabledAdminMcpTools();
  return [
    'Admin permission inventory (read-only runner view):',
    ...ADMIN_MCP_TOOL_NAMES.map((toolName) => {
      const status = enabledAdminTools.has(toolName)
        ? 'selected'
        : 'not selected';
      return `- mcp__myclaw__${toolName}: ${status}`;
    }),
    '',
    'Configured tool rules:',
    ...(configuredAllowedTools.length > 0
      ? configuredAllowedTools
          .slice()
          .sort()
          .map((tool) => `- ${tool}`)
      : ['- none visible to this runner']),
    '',
    'Selected skills:',
    ...(selectedSkillIds.length > 0
      ? selectedSkillIds
          .slice()
          .sort()
          .map((skill) => `- ${skill}`)
      : ['- none visible to this runner']),
    '',
    'Selected MCP servers:',
    ...(selectedMcpServerIds.length > 0
      ? selectedMcpServerIds
          .slice()
          .sort()
          .map((server) => `- ${server}`)
      : ['- none visible to this runner']),
    '',
    'Mutation status: read-only. Use admin_permission_revoke only after a durable host revocation service is wired; current revoke behavior fails closed.',
  ].join('\n');
}

function adminToolUnavailable(toolName: AdminMcpToolName): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const fullName = `mcp__myclaw__${toolName}`;
  return {
    content: [
      {
        type: 'text',
        text: [
          `${fullName} is not selected for this agent yet.`,
          `Ask a configured conversation approver to approve ${fullName}, then choose Always allow.`,
        ].join(' '),
      },
    ],
    isError: true,
  };
}

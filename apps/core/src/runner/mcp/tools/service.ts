import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nowIso } from '../../../shared/time/datetime.js';
import {
  availableSemanticCapabilities,
  capabilityStatusText,
  chatJid,
  isAdminMcpToolEnabled,
  TASKS_DIR,
  threadId,
} from '../context.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import {
  MCP_PROXY_WAIT_MS,
  SKILL_APPROVAL_WAIT_MS,
} from './service-constants.js';
import {
  formatMcpApprovalResponse,
  formatMcpCallToolResponse,
  formatMcpListToolsResponse,
  formatSkillProposalResponse,
} from './service-formatters.js';
import { registerSemanticCapabilityTools } from './capabilities.js';
import { registerAdminPermissionTools } from './admin-permissions.js';
import { registerSettingsTools } from './settings.js';
import { makeIpcId } from '../ipc-ids.js';
import type { AdminMcpToolName } from '../../../shared/admin-mcp-tools.js';
import { humanizeTechnicalIdentifier } from '../../../shared/user-visible-messages.js';
import {
  REQUEST_TOOL_ENABLE_SCOPE_GUIDANCE,
  SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
  UNREVIEWED_DISCOVERY_GUIDANCE,
} from '../../../shared/capability-guidance.js';

export function registerServiceTools(server: McpServer): void {
  registerSkillProposalTool(
    server,
    'request_skill_proposal',
    'Submit an agent-created or modified skill bundle for same-conversation admin review. Approval makes the skill available to this agent.',
  );
  registerSettingsTools(server, { isAdminToolEnabled: isAdminMcpToolEnabled });
  registerAdminPermissionTools(server, {
    isAdminToolEnabled: isAdminMcpToolEnabled,
  });

  server.tool(
    'capability_status',
    'Show selected Gantry capabilities, attached skills/MCP services, and high-level requestable capabilities for this agent.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: capabilityStatusText() }],
    }),
  );

  server.tool(
    'request_skill_install',
    'Request a skill source install for same-conversation admin approval. Approval installs staged files, or runs an approved installer command in host-controlled staging and imports the resulting SKILL.md package. Skill source approval records inventory only; reviewed gantry.skill.json actions become capability candidates.',
    {
      expectedFiles: z
        .array(z.string())
        .optional()
        .describe('Expected skill package files for review'),
      dependencies: z
        .array(z.string())
        .optional()
        .describe('Declared skill dependencies for review'),
      requiredEnvVars: z
        .array(z.string())
        .optional()
        .describe('Env var names this skill needs from Gantry Credentials'),
      files: z
        .array(
          z.object({
            path: z
              .string()
              .describe('Skill package-relative path, such as SKILL.md'),
            content: z.string().describe('UTF-8 file content'),
            contentType: z.string().optional().describe('Optional MIME type'),
          }),
        )
        .min(1)
        .max(50)
        .optional()
        .describe(
          'Staged skill files. Must include SKILL.md with name and description frontmatter.',
        ),
      installCommandArgv: z
        .array(z.string())
        .min(1)
        .max(40)
        .optional()
        .describe(
          'Optional installer command argv, such as an npx skills.sh or clawhub installer command. Use only when files are not available.',
        ),
      reason: z.string().describe('Why this skill should be installed'),
    },
    async (args) => {
      const wrongLaneGuidance = browserWrongLaneRequestGuidance(
        'request_skill_install',
        {
          expectedFiles: args.expectedFiles ?? [],
          dependencies: args.dependencies ?? [],
          requiredEnvVars: args.requiredEnvVars ?? [],
          reason: args.reason,
        },
      );
      if (wrongLaneGuidance) return wrongLaneGuidance;
      return submitCapabilityReviewTask(
        'request_skill_install',
        'Skill install',
        {
          expectedFiles: args.expectedFiles ?? [],
          dependencies: args.dependencies ?? [],
          requiredEnvVars: args.requiredEnvVars ?? [],
          files: args.files ?? [],
          installCommandArgv: args.installCommandArgv ?? [],
          reason: args.reason,
        },
      );
    },
  );
  server.tool(
    'request_skill_dependency_install',
    'Request host-installed dependencies needed by a reviewed skill. Approval records the admin decision; the agent never runs install commands directly.',
    {
      ecosystem: z
        .enum(['npm', 'brew', 'go', 'uv', 'download'])
        .describe('Dependency ecosystem or install channel'),
      packages: z
        .array(z.string())
        .optional()
        .describe('Package, module, formula, or artifact names to install'),
      commandArgv: z
        .array(z.string())
        .optional()
        .describe('Optional exact install command argv for admin review'),
      skillId: z
        .string()
        .optional()
        .describe('Optional reviewed skill id requiring the dependency'),
      skillName: z
        .string()
        .optional()
        .describe('Optional reviewed skill name requiring the dependency'),
      riskClass: z
        .enum(['low', 'medium', 'high', 'critical'])
        .optional()
        .describe('Requested risk classification'),
      reason: z
        .string()
        .describe('Why this dependency is needed for the skill'),
    },
    async (args) =>
      submitCapabilityReviewTask(
        'request_skill_dependency_install',
        'Skill dependency install',
        {
          ecosystem: args.ecosystem,
          packages: args.packages ?? [],
          commandArgv: args.commandArgv ?? [],
          skillId: args.skillId,
          skillName: args.skillName,
          riskClass: args.riskClass,
          reason: args.reason,
        },
      ),
  );
  server.tool(
    'request_permission',
    [
      'Request one reviewed transient or fallback permission for the current agent.',
      'Do not use this for durable capability grants or capability proposals; use capability_search/propose_capability so users approve reviewed capabilities.',
      'Use this directly for one-off exact tool access, provider/channel permissions, internal Browser requests, or scoped RunCommand fallback rules such as RunCommand(npm test *) when no reviewed semantic capability fits.',
      'Use request_skill_install/request_skill_proposal for skill sources and request_mcp_server for third-party MCP sources.',
      REQUEST_TOOL_ENABLE_SCOPE_GUIDANCE,
    ].join(' '),
    {
      permissionKind: z
        .enum(['tool', 'provider_capability'])
        .optional()
        .describe(
          'Use tool for SDK/host/browser/scheduler/memory/service/MCP tool access; use provider_capability for Slack/Teams/Telegram provider capabilities.',
        ),
      toolName: z
        .string()
        .optional()
        .describe(
          'Single public fallback tool name to enable. Use RunCommand only with a rule; use exact Gantry names such as FileEdit, FileWrite, WebRead, AgentDelegation, Browser, scheduler_create_job, or an MCP tool name for non-command tools.',
        ),
      toolNames: z
        .array(z.string())
        .optional()
        .describe(
          'Exact tool names to enable. Use multiple names only when the request truly needs them together.',
        ),
      rule: z
        .string()
        .optional()
        .describe(
          'Required scoped command pattern for persistent Bash approvals, such as npm test * or git status. For non-Bash tools this is reviewer context only and is not persisted.',
        ),
      temporaryOnly: z
        .boolean()
        .optional()
        .describe(
          'Set true when the permission is needed only for the current action or an exploratory one-off. Leave false/omitted only for semantic capabilities, Browser, exact Gantry admin tools, or persistent scoped RunCommand rules that are genuinely useful for future turns.',
        ),
      broadAccess: z
        .boolean()
        .optional()
        .describe(
          'Optional reviewer signal that the requested exact tool is broad. Explain the need in reason.',
        ),
      toolCategory: z
        .string()
        .optional()
        .describe(
          'Optional category such as sdk, host, browser, scheduler, memory, or service',
        ),
      riskClass: z
        .enum(['low', 'medium', 'high', 'critical'])
        .optional()
        .describe(
          'Requested risk classification. Broad shell, edit/write, network, credential, service, or wildcard MCP access should be high or critical.',
        ),
      permissionPolicy: z
        .string()
        .optional()
        .describe(
          'Optional requested permission policy such as "ask once" or "persistent".',
        ),
      sandboxProfile: z
        .string()
        .optional()
        .describe('Optional requested sandbox profile'),
      reason: z.string().describe('Why this exact tool capability is needed.'),
      channelTool: z
        .string()
        .optional()
        .describe(
          'Provider-native capability name, such as slack_file_access. Use only with permissionKind=provider_capability.',
        ),
      providerId: z
        .string()
        .optional()
        .describe('Optional provider such as slack, telegram, or teams'),
      requiredScopes: z
        .array(z.string())
        .optional()
        .describe('Provider scopes or permissions needed by this capability'),
      affectedConversations: z
        .array(z.string())
        .optional()
        .describe('Conversation ids or names affected by this capability'),
    },
    async (args) =>
      submitCapabilityReviewTask('request_permission', 'Permission', {
        permissionKind: args.permissionKind,
        toolName: args.toolName,
        toolNames: args.toolNames ?? [],
        rule: args.rule,
        temporaryOnly: args.temporaryOnly,
        broadAccess: args.broadAccess,
        toolCategory: args.toolCategory,
        riskClass: args.riskClass,
        permissionPolicy: args.permissionPolicy,
        sandboxProfile: args.sandboxProfile,
        channelTool: args.channelTool,
        providerId: args.providerId,
        requiredScopes: args.requiredScopes ?? [],
        affectedConversations: args.affectedConversations ?? [],
        reason: args.reason,
      }),
  );

  registerSemanticCapabilityTools(server, submitCapabilityReviewTask, {
    listCapabilities: () => availableSemanticCapabilities,
  });

  server.tool(
    'request_mcp_server',
    'Request a third-party MCP server source for admin review. Approval connects the source; raw MCP tools are inventory and do not become durable capabilities until reviewed.',
    {
      name: z
        .string()
        .describe('Short MCP server name, such as github or linear'),
      transport: z
        .literal('stdio_template')
        .describe('Requested MCP transport'),
      templateId: z
        .enum(['node-script', 'npx-package'])
        .describe('Reviewed stdio template to use'),
      args: z
        .array(z.string())
        .optional()
        .describe(
          'Template arguments. npx-package requires exactly one safe npm package spec.',
        ),
      sandboxProfileId: z
        .string()
        .describe('Reviewed sandbox profile for the stdio server process'),
      requestedToolPatterns: z
        .array(z.string())
        .optional()
        .describe('Expected MCP tool names, without the mcp__server__ prefix'),
      credentialNeeds: z
        .array(z.string())
        .optional()
        .describe('Credential reference names the admin should review'),
      reason: z.string().describe('Why this capability is needed'),
      docsUrl: z.string().optional().describe('Optional documentation URL'),
    },
    async (args) => {
      const wrongLaneGuidance = browserWrongLaneRequestGuidance(
        'request_mcp_server',
        {
          name: args.name,
          origin: undefined,
          requestedToolPatterns: args.requestedToolPatterns ?? [],
          credentialNeeds: args.credentialNeeds ?? [],
          reason: args.reason,
          docsUrl: args.docsUrl,
        },
      );
      if (wrongLaneGuidance) return wrongLaneGuidance;
      const taskId = makeIpcId('request-mcp');
      writeIpcFile(TASKS_DIR, {
        type: 'request_mcp_server',
        taskId,
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: {
          name: args.name,
          transport: args.transport,
          templateId: args.templateId,
          args: args.args ?? [],
          sandboxProfileId: args.sandboxProfileId,
          requestedToolPatterns: args.requestedToolPatterns ?? [],
          credentialNeeds: args.credentialNeeds ?? [],
          reason: args.reason,
          docsUrl: args.docsUrl,
        },
        timestamp: nowIso(),
      });

      const response = await waitForTaskResponse(
        taskId,
        SKILL_APPROVAL_WAIT_MS,
      );
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                response?.error ||
                'MCP server request was not recorded by the host.',
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatMcpApprovalResponse(
              response.data,
              response.message ||
                'MCP server source connected. Review needed for durable action capabilities.',
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'mcp_list_tools',
    'List tools from MCP server sources connected to this agent. This refreshes source inventory only; raw MCP tools are not durable capability ids.',
    {
      serverName: z
        .string()
        .optional()
        .describe('Optional connected MCP server name to inspect'),
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
            text: [
              formatMcpListToolsResponse(response.data),
              SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
              UNREVIEWED_DISCOVERY_GUIDANCE,
              capabilityStatusText(),
            ].join('\n\n'),
          },
        ],
      };
    },
  );

  server.tool(
    'mcp_call_tool',
    'Call a tool on an MCP server source only when the requested action is covered by reviewed current-run access. Use this for third-party MCP servers; do not call direct third-party mcp__server__tool names.',
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
    'service_restart',
    'Restart the Gantry service with config validation. Requires selected agent tool grant mcp__gantry__service_restart.',
    {},
    async () => {
      if (!isAdminMcpToolEnabled('service_restart')) {
        return adminToolUnavailable('service_restart');
      }
      const taskId = makeIpcId('service-restart');
      writeIpcFile(TASKS_DIR, {
        type: 'service_restart',
        taskId,
        targetJid: chatJid,
        chatJid,
        timestamp: nowIso(),
      });

      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Service restart requested, but host response timed out.',
            },
          ],
          isError: true,
        };
      }

      if (!response.ok) {
        const lines = [
          response.error || 'Service restart failed.',
          ...(response.details && response.details.length > 0
            ? response.details.map((item) => `- ${item}`)
            : []),
        ];
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Service restart completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'register_agent',
    `Register the current chat/channel agent so Gantry can respond to messages there. Requires selected agent tool grant mcp__gantry__register_agent and same-conversation approver approval.

The JID must be the current conversation. The folder name must be channel-prefixed: "{channel}_{conversation-name}" (e.g., "telegram_dev-team", "slack_eng", "teams_engineering"). Use lowercase with hyphens for the conversation name part.`,
    {
      jid: z
        .string()
        .describe(
          'The chat JID (e.g., "tg:-1001234567890", "sl:C0123456789", "teams:19:abc@thread.v2")',
        ),
      name: z.string().describe('Display name for the agent'),
      folder: z
        .string()
        .describe('Channel-prefixed folder name (e.g., "teams_engineering")'),
      trigger: z.string().describe('Trigger word (e.g., "@Default Agent")'),
      requiresTrigger: z
        .boolean()
        .optional()
        .describe(
          'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
        ),
    },
    async (args) => {
      if (!isAdminMcpToolEnabled('register_agent')) {
        return adminToolUnavailable('register_agent');
      }
      const taskId = makeIpcId('register-agent');
      const data = {
        type: 'register_agent',
        taskId,
        jid: args.jid,
        targetJid: chatJid,
        chatJid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        requiresTrigger: args.requiresTrigger ?? false,
        timestamp: nowIso(),
      };

      writeIpcFile(TASKS_DIR, data);

      const response = await waitForTaskResponse(taskId, 300_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Agent registration requested, but host response timed out.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        const lines = [
          response.error || 'Agent registration failed.',
          ...(response.details && response.details.length > 0
            ? response.details.map((item) => `- ${item}`)
            : []),
        ];
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              response.message ||
              `Agent "${args.name}" registered. It will start receiving messages immediately.`,
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

const BROWSER_WRONG_LANE_GUIDANCE = [
  'Browser control is a built-in Gantry tool capability, not a skill install or third-party MCP server request.',
  'Do not request browser automation through request_skill_install or request_mcp_server.',
  'Ask a configured conversation approver to approve Browser access, then use the browser tools.',
].join(' ');

function browserWrongLaneRequestGuidance(
  _toolName: 'request_skill_install' | 'request_mcp_server',
  payload: Record<string, unknown>,
) {
  if (!isBrowserWrongLanePayload(payload)) return null;
  return {
    content: [
      {
        type: 'text' as const,
        text: `${BROWSER_WRONG_LANE_GUIDANCE} No install request was recorded.`,
      },
    ],
    isError: true,
  };
}

function isBrowserWrongLanePayload(payload: Record<string, unknown>): boolean {
  return [
    payload.name,
    payload.slug,
    payload.spec,
    payload.origin,
    payload.docsUrl,
    payload.package,
    payload.expectedFiles,
    payload.dependencies,
    payload.installCommandArgv,
    payload.requestedToolPatterns,
  ]
    .flatMap(explicitWrongLaneText)
    .some(isBrowserWrongLaneText);
}

function explicitWrongLaneText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(explicitWrongLaneText);
  return [];
}

function isBrowserWrongLaneText(value: string): boolean {
  const normalized = value.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  return (
    normalized === 'browser' ||
    normalized === 'browser-control' ||
    compact === 'browserbackend' ||
    compact === 'browsercontrol'
  );
}

type CapabilityReviewToolName =
  | 'request_skill_install'
  | 'request_skill_dependency_install'
  | 'request_permission';

async function submitCapabilityReviewTask(
  toolName: CapabilityReviewToolName,
  requestLabel: string,
  payload: Record<string, unknown>,
) {
  const taskId = makeIpcId(toolName.replaceAll('_', '-'));
  writeIpcFile(TASKS_DIR, {
    type: toolName,
    taskId,
    runHandle: process.env.GANTRY_AGENT_RUN_HANDLE || undefined,
    jobId: process.env.GANTRY_JOB_ID || undefined,
    runId: process.env.GANTRY_JOB_RUN_ID || undefined,
    targetJid: chatJid,
    chatJid,
    authThreadId: threadId,
    payload,
    timestamp: nowIso(),
  });

  const response = await waitForTaskResponse(taskId, SKILL_APPROVAL_WAIT_MS);
  if (!response?.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text:
            response?.error ||
            `${requestLabel} request was not recorded by the host.`,
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
          toolName === 'request_skill_install'
            ? formatSkillProposalResponse(
                response.data,
                response.message ||
                  `${requestLabel} approved. It is available now.`,
              )
            : response.message ||
              `Approval requested for ${requestLabel}. It will be available after approval.`,
      },
    ],
  };
}

function registerSkillProposalTool(
  server: McpServer,
  toolName: 'request_skill_proposal',
  description: string,
): void {
  const requestLabel = 'Skill proposal';
  server.tool(
    toolName,
    description,
    {
      files: z
        .array(
          z.object({
            path: z
              .string()
              .describe('Skill package-relative path, such as SKILL.md'),
            content: z.string().describe('UTF-8 file content'),
            contentType: z.string().optional().describe('Optional MIME type'),
          }),
        )
        .min(1)
        .max(50)
        .describe(
          'Skill files. Must include SKILL.md with name and description frontmatter.',
        ),
      reason: z.string().describe('Why this skill is needed'),
    },
    async (args) => {
      const taskId = makeIpcId('request-skill');
      writeIpcFile(TASKS_DIR, {
        type: toolName,
        taskId,
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: {
          files: args.files,
          reason: args.reason,
        },
        timestamp: nowIso(),
      });

      const response = await waitForTaskResponse(
        taskId,
        SKILL_APPROVAL_WAIT_MS,
      );
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                response?.error ||
                `${requestLabel} request was not recorded by the host.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatSkillProposalResponse(
              response.data,
              response.message ||
                `${requestLabel} installed. It is available now.`,
            ),
          },
        ],
      };
    },
  );
}

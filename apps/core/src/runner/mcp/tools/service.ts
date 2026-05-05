import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nowIso, nowMs } from '../../../infrastructure/time/datetime.js';
import {
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
import { registerSettingsTools } from './settings.js';

export function registerServiceTools(server: McpServer): void {
  registerSkillProposalTool(
    server,
    'request_skill_proposal',
    'Submit an agent-created or modified skill bundle for same-conversation admin review. This creates a proposal only; it never approves, binds, or activates the skill.',
  );
  registerSettingsTools(server, { isAdminToolEnabled: isAdminMcpToolEnabled });

  server.tool(
    'capability_status',
    'Show selected MyClaw admin tool capabilities for this agent and exact request_permission arguments for requestable missing tools.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: capabilityStatusText() }],
    }),
  );

  server.tool(
    'request_skill_install',
    'Request a provider-backed skill install for same-conversation admin review. This records a review request only; it never installs, binds, or activates the skill directly.',
    {
      spec: z
        .string()
        .describe('Provider skill spec, such as clawhub:skill-slug@1.2.3'),
      provider: z.string().optional().describe('Optional skill provider name'),
      slug: z.string().optional().describe('Optional provider skill slug'),
      version: z
        .string()
        .optional()
        .describe('Optional requested skill version'),
      publisher: z
        .string()
        .optional()
        .describe('Optional provider or publisher identity'),
      verification: z
        .string()
        .optional()
        .describe('Optional verification or provenance summary'),
      expectedFiles: z
        .array(z.string())
        .optional()
        .describe('Expected skill package files for review'),
      dependencies: z
        .array(z.string())
        .optional()
        .describe('Declared skill dependencies for review'),
      reason: z.string().describe('Why this skill should be installed'),
    },
    async (args) =>
      submitCapabilityReviewTask('request_skill_install', 'Skill install', {
        spec: args.spec,
        provider: args.provider,
        slug: args.slug,
        version: args.version,
        publisher: args.publisher,
        verification: args.verification,
        expectedFiles: args.expectedFiles ?? [],
        dependencies: args.dependencies ?? [],
        reason: args.reason,
      }),
  );

  server.tool(
    'request_skill_dependency_install',
    'Request host-installed dependencies needed by a reviewed skill. This records a review request only; it never runs install commands directly.',
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
      'Request one reviewed permission or capability change for the current agent.',
      'Prefer letting the actual tool call trigger Allow once. Use this tool for planned persistent granular access, provider/channel capabilities, or when a capability is missing.',
      'Use Anthropic-compatible rule syntax when asking for persistent tool access: ToolName(scope-pattern), Edit(/path/**), WebFetch(domain:example.com), mcp__server__*, Agent(subagent-type).',
      'Broad whole-tool access is a last resort and must be explicit in the reason.',
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
          'Single tool name to enable, such as Bash, Edit, Write, WebFetch, Agent, browser_open, scheduler_create_job, or an MCP tool name.',
        ),
      toolNames: z
        .array(z.string())
        .optional()
        .describe(
          'Exact tool names to enable. Prefer one tool plus a scoped rule; use multiple names only when the request truly needs them together.',
        ),
      rule: z
        .string()
        .optional()
        .describe(
          'Optional granular scope for the requested tool. Use this instead of broad access when possible, for example "npm run test *", "/docs/**", "domain:github.com", "Explore", or "mcp__github__*".',
        ),
      temporaryOnly: z
        .boolean()
        .optional()
        .describe(
          'Set true when the permission is needed only for the current action or an exploratory one-off. Leave false/omitted only when a persistent rule is genuinely useful for future turns.',
        ),
      broadAccess: z
        .boolean()
        .optional()
        .describe(
          'Set true only when scoped rules are insufficient and the admin should intentionally consider whole-tool access. Explain why in reason.',
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
          'Optional requested permission policy. Prefer "ask once" or scoped persistent rules over broad persistent access.',
        ),
      sandboxProfile: z
        .string()
        .optional()
        .describe('Optional requested sandbox profile'),
      reason: z
        .string()
        .describe(
          'Why this exact scope is needed. If broadAccess is true, explain why narrower rules are insufficient.',
        ),
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

  server.tool(
    'request_mcp_server',
    'Request a third-party MCP server capability for admin review. This creates a pending request only; it never approves, binds, or activates the server.',
    {
      name: z
        .string()
        .describe('Short MCP server name, such as github or linear'),
      transport: z.enum(['http', 'sse']).describe('Requested MCP transport'),
      origin: z.string().optional().describe('Server URL'),
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
      const taskId = `request-mcp-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'request_mcp_server',
        taskId,
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: {
          name: args.name,
          transport: args.transport,
          origin: args.origin,
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
                'MCP server approved. It is available in this current run and future sessions.',
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'mcp_list_tools',
    'List tools from MCP servers that are already approved and bound to this agent. Use this for third-party MCP servers in current and future runs; do not call direct third-party mcp__server__tool names.',
    {
      serverName: z
        .string()
        .optional()
        .describe('Optional approved MCP server name to inspect'),
    },
    async (args) => {
      const taskId = `mcp-list-tools-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
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
              capabilityStatusText(),
            ].join('\n\n'),
          },
        ],
      };
    },
  );

  server.tool(
    'mcp_call_tool',
    'Call a tool on an MCP server that is already approved and bound to this agent. Use this for third-party MCP servers in current and future runs; do not call direct third-party mcp__server__tool names.',
    {
      serverName: z.string().describe('Approved MCP server name'),
      toolName: z
        .string()
        .describe('Raw MCP tool name without the mcp__server__ prefix'),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('JSON object arguments for the MCP tool'),
    },
    async (args) => {
      const taskId = `mcp-call-tool-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
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

  if (isAdminMcpToolEnabled('service_restart')) {
    server.tool(
      'service_restart',
      'Restart the MyClaw service with config validation. Requires selected agent capability tool:mcp__myclaw__service_restart.',
      {},
      async () => {
        const taskId = `service-restart-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'service_restart',
          taskId,
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
  }

  if (isAdminMcpToolEnabled('register_agent')) {
    server.tool(
      'register_agent',
      `Register a new chat/channel agent so MyClaw can respond to messages there. Requires selected agent capability tool:mcp__myclaw__register_agent.

Use available_groups.json to find the JID for a conversation. The folder name must be channel-prefixed: "{channel}_{conversation-name}" (e.g., "telegram_dev-team", "slack_eng", "teams_engineering"). Use lowercase with hyphens for the conversation name part.`,
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
        trigger: z.string().describe('Trigger word (e.g., "@Main Agent")'),
        requiresTrigger: z
          .boolean()
          .optional()
          .describe(
            'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
          ),
      },
      async (args) => {
        const taskId = `register-agent-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
        const data = {
          type: 'register_agent',
          taskId,
          jid: args.jid,
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
  const taskId = `${toolName.replaceAll('_', '-')}-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
  writeIpcFile(TASKS_DIR, {
    type: toolName,
    taskId,
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
          response.message ||
          `${requestLabel} sent to this chat for approval. It will not be available until approved.`,
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
      const taskId = `request-skill-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
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
                `${requestLabel} approved. It is available in this current run and future sessions.`,
            ),
          },
        ],
      };
    },
  );
}

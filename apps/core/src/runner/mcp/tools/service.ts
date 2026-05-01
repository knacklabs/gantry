import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nowIso, nowMs } from '../../../infrastructure/time/datetime.js';
import { chatJid, isMain, TASKS_DIR, threadId } from '../context.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';

const SKILL_APPROVAL_WAIT_MS = 5 * 60 * 1000;
const SAME_SESSION_SKILL_CONTEXT_MAX_BYTES = 256 * 1024;
const MCP_PROXY_WAIT_MS = 60 * 1000;

export function registerServiceTools(server: McpServer): void {
  registerSkillProposalTool(
    server,
    'request_skill_proposal',
    'Submit an agent-created or modified skill bundle for same-channel admin review. This creates a proposal only; it never approves, binds, or activates the skill.',
  );

  server.tool(
    'request_skill_install',
    'Request a provider-backed skill install for same-channel admin review. This records a review request only; it never installs, binds, or activates the skill directly.',
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
    'request_tool_enable',
    'Request SDK, host, browser, scheduler, memory, or service tools for same-channel admin review. This records a review request only; it never changes permissions directly.',
    {
      toolName: z
        .string()
        .optional()
        .describe('Single tool name to enable, such as Bash or Write'),
      toolNames: z
        .array(z.string())
        .optional()
        .describe('Exact tool names to enable'),
      toolCategory: z
        .string()
        .optional()
        .describe(
          'Optional category such as sdk, host, browser, scheduler, memory, or service',
        ),
      riskClass: z
        .enum(['low', 'medium', 'high', 'critical'])
        .optional()
        .describe('Requested risk classification'),
      permissionPolicy: z
        .string()
        .optional()
        .describe('Optional requested permission policy'),
      sandboxProfile: z
        .string()
        .optional()
        .describe('Optional requested sandbox profile'),
      reason: z.string().describe('Why these tools are needed'),
    },
    async (args) =>
      submitCapabilityReviewTask('request_tool_enable', 'Tool enable', {
        toolName: args.toolName,
        toolNames: args.toolNames ?? [],
        toolCategory: args.toolCategory,
        riskClass: args.riskClass,
        permissionPolicy: args.permissionPolicy,
        sandboxProfile: args.sandboxProfile,
        reason: args.reason,
      }),
  );

  server.tool(
    'request_channel_tool_enable',
    'Request a channel-specific capability for same-channel admin review. This records a review request only; it never changes channel permissions directly.',
    {
      channelTool: z
        .string()
        .describe('Channel capability name, such as slack_file_access'),
      channelProvider: z
        .string()
        .optional()
        .describe(
          'Optional channel provider such as slack, telegram, or teams',
        ),
      requiredScopes: z
        .array(z.string())
        .optional()
        .describe('Provider scopes or permissions needed by this capability'),
      affectedConversations: z
        .array(z.string())
        .optional()
        .describe('Conversation ids or names affected by this capability'),
      reason: z.string().describe('Why this channel capability is needed'),
    },
    async (args) =>
      submitCapabilityReviewTask(
        'request_channel_tool_enable',
        'Channel tool enable',
        {
          channelTool: args.channelTool,
          channelProvider: args.channelProvider,
          requiredScopes: args.requiredScopes ?? [],
          affectedConversations: args.affectedConversations ?? [],
          reason: args.reason,
        },
      ),
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
            text: formatMcpListToolsResponse(response.data),
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

  server.tool(
    'service_restart',
    'Restart the MyClaw service with config validation. Main agent only. If validation fails, returns actionable errors so you can correct settings and retry.',
    {},
    async () => {
      if (!isMain) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Only the main agent can restart the service.',
            },
          ],
          isError: true,
        };
      }

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

  server.tool(
    'register_agent',
    `Register a new chat/channel agent so MyClaw can respond to messages there. Main agent only.

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
      if (!isMain) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Only the main agent can register new agents.',
            },
          ],
          isError: true,
        };
      }

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

type CapabilityReviewToolName =
  | 'request_skill_install'
  | 'request_skill_dependency_install'
  | 'request_tool_enable'
  | 'request_channel_tool_enable';

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

function formatMcpApprovalResponse(data: unknown, message: string): string {
  const context = parseApprovedMcpContext(data);
  if (!context) return message;
  return [
    message,
    '',
    'Same-session MCP usage:',
    `- List approved tools: call mcp_list_tools with serverName="${context.server.name}"`,
    `- Call an approved tool: call mcp_call_tool with serverName="${context.server.name}", toolName="<tool>", arguments={...}`,
    context.approvedToolNames.length > 0
      ? `- Approved raw tool names: ${context.approvedToolNames.join(', ')}`
      : '- No explicit tool names were provided; use mcp_list_tools to inspect approved tools.',
    '',
    'Future sessions use the same MyClaw proxy tools. Do not call direct third-party MCP tool names.',
  ].join('\n');
}

function formatMcpListToolsResponse(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'No approved MCP tools were returned.';
  }
  const servers = Array.isArray((data as Record<string, unknown>).servers)
    ? ((data as Record<string, unknown>).servers as unknown[])
    : [];
  if (servers.length === 0) return 'No approved MCP tools are available.';
  const lines = ['Approved MCP tools:'];
  for (const server of servers) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      continue;
    }
    const record = server as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : 'unknown';
    const tools = Array.isArray(record.tools) ? record.tools : [];
    lines.push(`\n## ${name}`);
    if (tools.length === 0) {
      lines.push('- No approved tools exposed by this server.');
      continue;
    }
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
      const item = tool as Record<string, unknown>;
      const toolName =
        typeof item.name === 'string' ? item.name : 'unnamed_tool';
      const description =
        typeof item.description === 'string' ? ` - ${item.description}` : '';
      lines.push(`- ${toolName}${description}`);
    }
  }
  return lines.join('\n');
}

function formatMcpCallToolResponse(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data ?? null, null, 2);
}

function parseApprovedMcpContext(data: unknown): {
  server: { id: string; name: string };
  approvedToolNames: string[];
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'approved_mcp_context') return null;
  const server =
    record.server &&
    typeof record.server === 'object' &&
    !Array.isArray(record.server)
      ? (record.server as Record<string, unknown>)
      : null;
  if (
    !server ||
    typeof server.id !== 'string' ||
    typeof server.name !== 'string'
  ) {
    return null;
  }
  return {
    server: { id: server.id, name: server.name },
    approvedToolNames: Array.isArray(record.approvedToolNames)
      ? record.approvedToolNames.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  };
}

function formatSkillProposalResponse(data: unknown, message: string): string {
  const context = parseApprovedSkillContext(data);
  if (!context) return message;
  const lines = [
    message,
    '',
    'Same-session skill context:',
    `- Skill: ${context.skill.name}`,
    `- Skill ID: ${context.skill.id}`,
    context.skill.description
      ? `- Description: ${context.skill.description}`
      : undefined,
    context.skill.contentHash
      ? `- Package hash: ${context.skill.contentHash}`
      : undefined,
    '',
    'Use this approved skill immediately in the current session by following its SKILL.md. Future sessions will load it from MyClaw skill storage.',
    '',
    'Approved skill files:',
  ].filter((line): line is string => line !== undefined);

  let remainingBytes = SAME_SESSION_SKILL_CONTEXT_MAX_BYTES;
  for (const file of context.files) {
    const contentBytes = Buffer.byteLength(file.content, 'utf-8');
    lines.push('');
    lines.push(`## ${file.path}`);
    if (file.contentHash || typeof file.sizeBytes === 'number') {
      lines.push(
        [
          file.contentHash ? `hash=${file.contentHash}` : undefined,
          typeof file.sizeBytes === 'number'
            ? `size=${file.sizeBytes} bytes`
            : undefined,
        ]
          .filter(Boolean)
          .join(', '),
      );
    }
    if (remainingBytes <= 0) {
      lines.push(
        '[Content omitted because the approved skill bundle is large.]',
      );
      continue;
    }
    const visibleContent =
      contentBytes <= remainingBytes
        ? file.content
        : file.content.slice(0, remainingBytes);
    remainingBytes -= Buffer.byteLength(visibleContent, 'utf-8');
    lines.push('```');
    lines.push(visibleContent);
    lines.push('```');
    if (contentBytes > Buffer.byteLength(visibleContent, 'utf-8')) {
      lines.push('[Content truncated for same-session context.]');
    }
  }
  return lines.join('\n');
}

function parseApprovedSkillContext(data: unknown): {
  skill: {
    id: string;
    name: string;
    description?: string;
    contentHash?: string;
  };
  files: Array<{
    path: string;
    content: string;
    contentHash?: string;
    sizeBytes?: number;
  }>;
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'approved_skill_context') return null;
  const skill =
    record.skill &&
    typeof record.skill === 'object' &&
    !Array.isArray(record.skill)
      ? (record.skill as Record<string, unknown>)
      : null;
  if (
    !skill ||
    typeof skill.id !== 'string' ||
    typeof skill.name !== 'string'
  ) {
    return null;
  }
  const files = Array.isArray(record.files)
    ? record.files
        .map((file) => {
          if (!file || typeof file !== 'object' || Array.isArray(file)) {
            return null;
          }
          const item = file as Record<string, unknown>;
          if (
            typeof item.path !== 'string' ||
            typeof item.content !== 'string'
          ) {
            return null;
          }
          return {
            path: item.path,
            content: item.content,
            ...(typeof item.contentHash === 'string'
              ? { contentHash: item.contentHash }
              : {}),
            ...(typeof item.sizeBytes === 'number'
              ? { sizeBytes: item.sizeBytes }
              : {}),
          };
        })
        .filter((file): file is NonNullable<typeof file> => file !== null)
    : [];
  if (files.length === 0) return null;
  return {
    skill: {
      id: skill.id,
      name: skill.name,
      ...(typeof skill.description === 'string'
        ? { description: skill.description }
        : {}),
      ...(typeof skill.contentHash === 'string'
        ? { contentHash: skill.contentHash }
        : {}),
    },
    files,
  };
}

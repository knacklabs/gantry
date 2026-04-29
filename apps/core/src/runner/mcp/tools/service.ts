import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nowIso, nowMs } from '../../../infrastructure/time/datetime.js';
import { chatJid, isMain, TASKS_DIR, threadId } from '../context.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';

export function registerServiceTools(server: McpServer): void {
  server.tool(
    'request_skill_draft',
    'Submit a proposed Claude skill for same-channel admin review. This creates a draft only; it never approves, binds, or activates the skill.',
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
        type: 'request_skill_draft',
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

      const response = await waitForTaskResponse(taskId, 15_000);
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                response?.error ||
                'Skill draft request was not recorded by the host.',
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
              'Skill draft sent to this chat for approval. It will not be available until approved.',
          },
        ],
      };
    },
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

      const response = await waitForTaskResponse(taskId, 15_000);
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
            text:
              response.message ||
              'MCP server request sent to this chat for approval. It will not be available until approved.',
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

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
    {
      jid: z
        .string()
        .describe(
          'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
        ),
      name: z.string().describe('Display name for the agent'),
      folder: z
        .string()
        .describe('Channel-prefixed folder name (e.g., "telegram_dev-team")'),
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

      const response = await waitForTaskResponse(taskId, 15_000);
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

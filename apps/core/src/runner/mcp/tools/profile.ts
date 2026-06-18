import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { MAX_AGENT_PROFILE_CONTENT_BYTES } from '@gantry/contracts';

import { nowIso } from '../../../shared/time/datetime.js';
import { chatJid, TASKS_DIR, threadId } from '../context.js';
import { makeIpcId } from '../ipc-ids.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import { SKILL_APPROVAL_WAIT_MS } from './service-constants.js';

const PROFILE_READ_WAIT_MS = 20_000;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

export function registerProfileTools(server: McpServer): void {
  server.tool(
    'agent_profile_read',
    "Read this agent's own profile file (SOUL.md identity/voice or AGENTS.md how-it-works). Read-only; returns current content with its version and hash so you can propose a precise update.",
    {
      file: z
        .enum(['soul', 'agents'])
        .describe(
          'Which profile file to read: soul (SOUL.md) or agents (AGENTS.md).',
        ),
    },
    async (args) => {
      const taskId = makeIpcId('agent-profile-read');
      writeIpcFile(TASKS_DIR, {
        type: 'agent_profile_read',
        taskId,
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: { file: args.file },
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, PROFILE_READ_WAIT_MS);
      if (!response?.ok) {
        return textResult(
          response?.error || 'Profile read was not recorded by the host.',
          true,
        );
      }
      const profileData =
        response.data && typeof response.data === 'object'
          ? (response.data as Record<string, unknown>)
          : {};
      const profileContent =
        typeof profileData.content === 'string' ? profileData.content : '';
      const profileVersion =
        typeof profileData.version === 'number'
          ? profileData.version
          : undefined;
      if (profileVersion !== undefined) {
        return textResult(
          `Profile (version ${profileVersion}):\n\n${profileContent}`,
        );
      }
      return textResult(
        profileContent || response.message || 'Profile read complete.',
      );
    },
  );

  server.tool(
    'request_agent_profile_update',
    "Propose a reviewed update to this agent's own profile file (SOUL.md or AGENTS.md). A configured approver sees a diff and approves once. Use this instead of the generic file tool for profile changes. Pass expectedVersion (from agent_profile_read) to guard against stale writes.",
    {
      file: z
        .enum(['soul', 'agents'])
        .describe(
          'Which profile file to update: soul (SOUL.md) or agents (AGENTS.md).',
        ),
      content: z
        .string()
        .min(1)
        .max(MAX_AGENT_PROFILE_CONTENT_BYTES)
        .describe('Full new file content (UTF-8 markdown).'),
      summary: z
        .string()
        .describe('Short plain-language summary of what changes and why.'),
      expectedVersion: z
        .number()
        .int()
        .nonnegative()
        .describe(
          'Version returned by agent_profile_read. If it no longer matches, the update is rejected so you can refresh and retry.',
        ),
    },
    async (args) => {
      const taskId = makeIpcId('request-agent-profile');
      writeIpcFile(TASKS_DIR, {
        type: 'request_agent_profile_update',
        taskId,
        targetJid: chatJid,
        chatJid,
        authThreadId: threadId,
        payload: {
          file: args.file,
          content: args.content,
          summary: args.summary,
          expectedVersion: args.expectedVersion,
        },
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(
        taskId,
        SKILL_APPROVAL_WAIT_MS,
      );
      if (!response?.ok) {
        return textResult(
          response?.error ||
            'Profile update request was not recorded by the host.',
          true,
        );
      }
      return textResult(
        response.message ||
          'Profile update approved. It applies on the next run.',
      );
    },
  );
}

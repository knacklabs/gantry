import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CAPABILITY_RUN_MAX_ARGS } from '../../../shared/structured-local-cli.js';
import { formatTaskFailureLines } from '../formatting.js';
import { chatJid, providerAccountId, TASKS_DIR, threadId } from '../context.js';
import { makeIpcId } from '../ipc-ids.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';

const CAPABILITY_RUN_RESPONSE_TIMEOUT_MS = 125_000;

export function registerCapabilityRunTool(server: McpServer): void {
  server.tool(
    'capability_run',
    'Run a granted local CLI capability with structured arguments. Pass only argv entries after the executable. Gantry validates them against the reviewed capability pattern and runs without an agent-authored shell command.',
    {
      capabilityId: z
        .string()
        .min(1)
        .max(255)
        .describe('Granted semantic local CLI capability id.'),
      args: z
        .array(z.string())
        .max(CAPABILITY_RUN_MAX_ARGS)
        .describe(
          'Arguments after the reviewed executable, as separate entries.',
        ),
    },
    async ({ capabilityId, args }) => {
      const taskId = makeIpcId('capability-run');
      writeIpcFile(TASKS_DIR, {
        type: 'capability_run',
        taskId,
        chatJid,
        providerAccountId,
        authThreadId: threadId,
        payload: { capabilityId, args },
      });
      const response = await waitForTaskResponse(
        taskId,
        CAPABILITY_RUN_RESPONSE_TIMEOUT_MS,
      );
      if (!response) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Capability execution timed out before the host returned a result.',
            },
          ],
        };
      }
      if (!response.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Capability execution was rejected.',
              ).join('\n'),
            },
          ],
        };
      }
      const data = response.data;
      const result =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {};
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ stdout, stderr }),
          },
        ],
      };
    },
  );
}

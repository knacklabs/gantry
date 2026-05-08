import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { groupFolder, memoryDefaultScope, memoryUserId } from '../context.js';
import { formatMemoryToolResponse } from '../formatting.js';
import { requestMemoryAction } from '../ipc.js';
import {
  buildMemorySavePayload,
  buildProcedureSavePayload,
} from './memory-payload.js';

export function registerMemoryTools(server: McpServer): void {
  server.tool(
    'memory_search',
    'Search durable MyClaw memory. Returns real scoped memory statements, procedures, and source snippets with provenance; scores are only ranking metadata.',
    {
      query: z.string().describe('Search query'),
      group_folder: z
        .string()
        .optional()
        .describe('Optional override group folder (defaults to current group)'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results'),
    },
    async (args) => {
      const response = await requestMemoryAction('memory_search', {
        query: args.query,
        group_folder: args.group_folder || groupFolder,
        limit: args.limit,
      });
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory search failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'memory_save',
    'Save a durable memory statement. Defaults to group scope in group/channel conversations and user scope in DMs. Use this for preferences, facts, decisions, corrections, and constraints that should survive future sessions. Do not save raw logs, temporary task progress, secrets, generic summaries, or common/global memory without an approved admin path.',
    {
      scope: z.enum(['user', 'group', 'global']).optional(),
      group_folder: z.string().optional(),
      kind: z
        .enum(['preference', 'decision', 'fact', 'correction', 'constraint'])
        .optional(),
      key: z
        .string()
        .describe(
          'Stable key such as preference:response-style or decision:memory-backend',
        ),
      value: z
        .string()
        .describe(
          'One human-readable durable statement, not a transcript dump',
        ),
      confidence: z.number().min(0).max(1).optional(),
      source: z.string().optional(),
    },
    async (args) => {
      const response = await requestMemoryAction(
        'memory_save',
        buildMemorySavePayload(args, { memoryDefaultScope, memoryUserId }),
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory save failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'memory_patch',
    'Patch an existing memory item using optimistic concurrency.',
    {
      id: z.string(),
      expected_version: z.number().int().min(1),
      key: z.string().optional(),
      value: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
      const response = await requestMemoryAction('memory_patch', args);
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory patch failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'procedure_save',
    'Save a reusable procedure learned from successful work.',
    {
      scope: z.enum(['user', 'group', 'global']).optional(),
      group_folder: z.string().optional(),
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
      source: z.string().optional(),
    },
    async (args) => {
      const response = await requestMemoryAction(
        'procedure_save',
        buildProcedureSavePayload(args, { memoryDefaultScope, memoryUserId }),
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Procedure save failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'procedure_patch',
    'Patch an existing procedure using optimistic concurrency.',
    {
      id: z.string(),
      expected_version: z.number().int().min(1),
      title: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
      const response = await requestMemoryAction('procedure_patch', args);
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Procedure patch failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'memory_consolidate',
    'Run a deep memory consolidation pass for the current trusted memory subject.',
    {},
    async () => {
      const response = await requestMemoryAction('memory_consolidate', {});
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory consolidation failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'memory_dream',
    'Run a full memory dreaming pass for the current trusted memory subject.',
    {},
    async () => {
      const response = await requestMemoryAction('memory_dream', {});
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory dreaming failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'memory_review_pending',
    'List pending host-validated memory mutation reviews for the current trusted memory subject.',
    {},
    async () => {
      const response = await requestMemoryAction('memory_review_pending', {});
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory review lookup failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );

  server.tool(
    'memory_review_decision',
    'Approve, reject, or edit-approve one pending memory mutation review. This approves only the specific reviewed data change, not any tool capability.',
    {
      review_id: z.string(),
      decision: z.enum(['approve', 'reject', 'edit_approve']),
      edited_value: z.string().optional(),
      edited_reason: z.string().optional(),
    },
    async (args) => {
      const response = await requestMemoryAction(
        'memory_review_decision',
        args,
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory review decision failed: ${response.error || 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: formatMemoryToolResponse(response) },
        ],
      };
    },
  );
}

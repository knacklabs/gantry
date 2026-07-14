import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  formatBrainQueryResponse,
  formatBrainSearchResponse,
  formatBrainWriteResponse,
} from '../formatting.js';
import { requestMemoryAction } from '../ipc.js';

async function brainToolResult(
  label: string,
  action: 'brain_search' | 'brain_query' | 'brain_write',
  args: Record<string, unknown>,
  format: (response: { provider?: string; data?: unknown }) => string,
) {
  const response = await requestMemoryAction(action, args);
  if (!response.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${label} failed: ${response.error || 'unknown error'}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: format(response) }],
  };
}

export function registerBrainTools(server: McpServer): void {
  server.tool(
    'brain_search',
    'Search the shared Gantry company brain across agents. Returns app-scoped markdown pages with graph evidence and citations. Check it before saying organization-level information is unknown.',
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async (args) =>
      brainToolResult('Brain search', 'brain_search', args, (response) =>
        formatBrainSearchResponse(response),
      ),
  );

  server.tool(
    'brain_query',
    'Answer a question from the shared Gantry company brain with citations and explicit gaps. Use it before telling the user organization-level knowledge is unknown.',
    {
      question: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async (args) =>
      brainToolResult('Brain query', 'brain_query', args, (response) =>
        formatBrainQueryResponse(response),
      ),
  );

  server.tool(
    'brain_write',
    'Write or update one markdown page in the shared Gantry company brain. Pages are visible to every agent and user in this org: only write durable organization-level facts (people, companies, projects, decisions). Never write personal or user-private context — that belongs in memory_save. Use stable slugs and cite source details in frontmatter or page body.',
    {
      slug: z.string().min(1),
      markdown: z.string().min(1),
      title: z.string().optional(),
      source_ref: z.string().optional(),
    },
    async (args) =>
      brainToolResult('Brain write', 'brain_write', args, (response) =>
        formatBrainWriteResponse(response),
      ),
  );
}

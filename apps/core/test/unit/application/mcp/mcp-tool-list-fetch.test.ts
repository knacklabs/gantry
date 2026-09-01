import { describe, expect, it } from 'vitest';

import { fetchMcpToolListPages } from '@core/application/mcp/mcp-tool-list-fetch.js';

describe('MCP tool-list schema preservation', () => {
  it('preserves an exact bounded schema deeper than descriptive metadata limits', async () => {
    const inputSchema = nestedObjectSchema(12);
    const result = await fetchMcpToolListPages({
      client: {
        listTools: async () => ({
          tools: [{ name: 'deep_operation', inputSchema }],
        }),
      },
      timeoutMs: 1_000,
    });

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.inputSchema).toEqual(inputSchema);
    expect(JSON.stringify(result.tools[0]?.inputSchema)).not.toContain(
      '[metadata truncated]',
    );
  });
});

function nestedObjectSchema(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let index = 0; index < depth; index += 1) {
    schema = {
      type: 'object',
      properties: { [`level${index}`]: schema },
      required: [`level${index}`],
      additionalProperties: false,
    };
  }
  return schema;
}

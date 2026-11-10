import { describe, expect, it } from 'vitest';
import { attachMcpToolReceipt } from '@core/application/mcp/mcp-tool-receipt.js';
import { MAX_MCP_TOOL_RESULT_CHARS } from '@core/application/mcp/mcp-tool-output-bounds.js';

describe('run-scoped MCP receipts', () => {
  it('preserves receipts and remote error flags when large payloads are bounded', () => {
    for (const isError of [false, true]) {
      const result = attachMcpToolReceipt(
        {
          isError,
          toolCallId: 'forged',
          content: [
            {
              type: 'text',
              text: 'x'.repeat(MAX_MCP_TOOL_RESULT_CHARS + 1000),
            },
          ],
        },
        'mcp-call:owned',
      ) as Record<string, unknown>;
      expect(result.toolCallId).toBe('mcp-call:owned');
      if (isError) expect(result.isError).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(
        MAX_MCP_TOOL_RESULT_CHARS + 512,
      );
    }
  });
});

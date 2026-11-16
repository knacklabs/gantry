import { boundMcpToolResultForReturn } from './mcp-tool-output-bounds.js';

/** Keeps trusted receipt metadata outside the bounded remote payload. */
export function attachMcpToolReceipt(
  result: unknown,
  toolCallId: string,
): unknown {
  const bounded = boundMcpToolResultForReturn(result);
  const record =
    bounded && typeof bounded === 'object' && !Array.isArray(bounded)
      ? (bounded as Record<string, unknown>)
      : null;
  return record && Array.isArray(record.content)
    ? {
        ...record,
        toolCallId,
        content: [
          {
            type: 'text',
            text: `Gantry receipt toolCallId: ${toolCallId}. Use this ID for provenance; remote or model call IDs are not Gantry receipts.`,
          },
          ...record.content,
        ],
      }
    : record
      ? { ...record, toolCallId }
      : { toolCallId, result: bounded };
}

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const ipc = vi.hoisted(() => ({ write: vi.fn(), wait: vi.fn() }));
vi.mock('@core/runner/mcp/ipc.js', () => ({
  writeIpcFile: ipc.write,
  waitForTaskResponse: ipc.wait,
}));
describe('source document renderer preflight', () => {
  it.each([
    {
      name: 'ragged table',
      change: {
        blocks: [
          {
            type: 'table',
            headers: ['Question', 'Reference'],
            rows: [['one cell']],
          },
        ],
      },
    },
    { name: 'missing extension', change: { fileName: 'Report' } },
    { name: 'reserved filename', change: { fileName: 'CON.pdf' } },
    {
      name: 'total text bound',
      change: {
        blocks: [
          { type: 'paragraph', text: 'x'.repeat(60000) },
          { type: 'paragraph', text: 'x'.repeat(60000) },
        ],
      },
    },
  ])(
    'returns a correctable result for $name without submitting IPC',
    async ({ change }) => {
      ipc.write.mockClear();
      ipc.wait.mockClear();
      vi.stubEnv('GANTRY_IPC_DIR', '/tmp/gantry-document-input-fixture');
      const { registerSourceDocumentTools } =
        await import('../../../src/runner/mcp/tools/source-document.js');
      const server = new McpServer({ name: 'fixture', version: '1' });
      registerSourceDocumentTools(server);
      const client = new Client({ name: 'fixture', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(a);
        await client.connect(b);
        const result = await client.callTool({
          name: 'source_document',
          arguments: {
            format: 'pdf',
            fileName: 'Report.pdf',
            title: 'Report',
            blocks: [{ type: 'paragraph', text: 'Text' }],
            citationIds: [],
            metadataFields: [],
            ...change,
          },
        });
        expect(result.isError).not.toBe(true);
        expect(
          JSON.parse((result.content as { text: string }[])[0]!.text),
        ).toMatchObject({ status: 'invalid_document_input', retryable: true });
        expect(ipc.write).not.toHaveBeenCalled();
        expect(ipc.wait).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
        vi.unstubAllEnvs();
      }
    },
  );
});

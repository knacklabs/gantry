import { it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ConvertSourceDocumentRequestSchema } from '@gantry/contracts';
it('advertises conversion through the actual MCP tool list and rejects content overrides before IPC', async () => {
  vi.stubEnv('GANTRY_IPC_DIR', '/tmp/gantry-conversion-tool-fixture');
  const { registerSourceDocumentTools } =
    await import('../../../src/runner/mcp/tools/source-document.js');
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerSourceDocumentTools(server);
  const client = new Client({ name: 'fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = await client.listTools();
    const tool = tools.tools.find((tool) => tool.name === 'source_document')!;
    expect(tool.inputSchema.properties).toHaveProperty(
      'convertExistingArtifactId',
    );
    expect(tool.inputSchema.properties).toHaveProperty('targetFormat');
    const bad = await client.callTool({
      name: 'source_document',
      arguments: {
        convertExistingArtifactId: 'F',
        targetFormat: 'docx',
        title: 'replacement',
      },
    });
    expect(bad.isError).toBe(true);
    expect(() =>
      ConvertSourceDocumentRequestSchema.parse({
        convertExistingArtifactId: 'F',
        targetFormat: 'docx',
        blocks: [],
      }),
    ).toThrow();
  } finally {
    await client.close();
    await server.close();
    vi.unstubAllEnvs();
  }
});

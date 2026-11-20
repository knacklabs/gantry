import { afterEach, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const memory = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@core/runner/mcp/ipc.js', () => ({
  requestMemoryAction: memory.request,
}));
afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
async function tools(native = true) {
  vi.doMock('@core/runner/mcp/context.js', () => ({
    workspaceFolder: 'workspace',
    memoryDefaultScope: 'group',
    memoryUserId: 'person',
    sourceWorkspaceMemoryId: native ? 'W1' : undefined,
  }));
  const { registerMemoryTools } =
    await import('@core/runner/mcp/tools/memory.js');
  const server = new McpServer({ name: 'memory-correction', version: '1' });
  registerMemoryTools(server);
  const client = new Client({ name: 'memory-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
const valid = {
  key: 'preference:explanation',
  value: 'Explain terms in plain words, preserving official requirements.',
  kind: 'preference',
  scope: 'user',
  source: 'discussion-explicit',
  supporting_source_ids: ['M1'],
};
it.each([
  { source: undefined },
  { source: 'personal-preference' },
  { supporting_source_ids: [] },
  { supporting_source_ids: ['M1', 'M1'] },
  { kind: 'fact' },
])(
  'returns a nonfatal correction for invalid native provenance %#',
  async (change) => {
    const run = await tools();
    try {
      const definition = (await run.client.listTools()).tools.find(
        (tool) => tool.name === 'memory_save',
      )!;
      expect(JSON.stringify(definition.inputSchema)).toContain(
        'discussion-explicit',
      );
      expect((definition.inputSchema.properties?.source as any).enum).toEqual([
        'discussion-explicit',
        'discussion-inferred',
      ]);
      expect(definition.description).toContain(
        'source MUST be discussion-explicit',
      );
      const result = await run.client.callTool({
        name: 'memory_save',
        arguments: { ...valid, ...change },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as any)[0].text)).toMatchObject({
        status: 'invalid_memory_input',
        saved: false,
        retryable: true,
      });
      expect(memory.request).not.toHaveBeenCalled();
    } finally {
      await run.close();
    }
  },
);
it('keeps host rejection nonfatal and accepts a corrected explicit save only after confirmed receipt', async () => {
  const run = await tools();
  try {
    memory.request
      .mockResolvedValueOnce({
        ok: false,
        error: 'Learning requires explicit or repeated-correction provenance',
      })
      .mockResolvedValueOnce({
        ok: true,
        provider: 'postgres',
        data: { memory: { id: 'confirmed', version: 1 } },
      });
    const failed = await run.client.callTool({
      name: 'memory_save',
      arguments: valid,
    });
    expect(failed.isError).not.toBe(true);
    expect(JSON.parse((failed.content as any)[0].text)).toMatchObject({
      status: 'memory_save_unconfirmed',
      confirmed: false,
    });
    const corrected = await run.client.callTool({
      name: 'memory_save',
      arguments: valid,
    });
    expect(corrected.isError).not.toBe(true);
    expect(memory.request).toHaveBeenCalledTimes(2);
    expect(memory.request.mock.calls[1][1]).toMatchObject({
      source: 'discussion-explicit',
      supporting_source_ids: ['M1'],
      scope: 'user',
    });
  } finally {
    await run.close();
  }
});
it('preserves ordinary workload memory error behavior', async () => {
  const run = await tools(false);
  try {
    memory.request.mockResolvedValueOnce({ ok: false, error: 'Denied' });
    const result = await run.client.callTool({
      name: 'memory_save',
      arguments: { key: 'x', value: 'y' },
    });
    expect(result.isError).toBe(true);
  } finally {
    await run.close();
  }
});

it('does not claim a save or repeat IPC when a native acknowledgement is unavailable', async () => {
  const run = await tools();
  try {
    memory.request.mockRejectedValueOnce(
      new Error('acknowledgement unavailable'),
    );
    const result = await run.client.callTool({
      name: 'memory_save',
      arguments: valid,
    });
    expect(result.isError).not.toBe(true);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data).toMatchObject({
      status: 'memory_save_unconfirmed',
      confirmed: false,
      retryable: false,
    });
    expect(data).not.toHaveProperty('saved');
    expect(memory.request).toHaveBeenCalledOnce();
  } finally {
    await run.close();
  }
});

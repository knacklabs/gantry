import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, it, expect, vi } from 'vitest';

const previousIpcDir = process.env.GANTRY_IPC_DIR;
const tempRoots: string[] = [];

afterEach(() => {
  vi.resetModules();
  if (previousIpcDir === undefined) delete process.env.GANTRY_IPC_DIR;
  else process.env.GANTRY_IPC_DIR = previousIpcDir;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('does not advertise a removed tool parameter in either scheduler job tool', async () => {
  const ipcDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-scheduler-schema-'),
  );
  tempRoots.push(ipcDir);
  process.env.GANTRY_IPC_DIR = ipcDir;
  const { registerSchedulerTools } =
    await import('../../../../src/runner/mcp/tools/scheduler.js');
  const server = new McpServer({
    name: 'scheduler-schema-test',
    version: '1.0.0',
  });
  registerSchedulerTools(server);
  const client = new Client({
    name: 'scheduler-schema-test-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of ['scheduler_upsert_job', 'scheduler_update_job']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, `${name} must be advertised`).toBeDefined();
      expect(tool?.inputSchema.properties).not.toHaveProperty('required_tools');
    }
  } finally {
    await client.close();
    await server.close();
  }
});

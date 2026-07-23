import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { writeTestAttachment } from '../../agent-e2e/fixtures/attachment-fixture.js';
import {
  DENYLISTED_EGRESS_HOST,
  startAllowedHostServer,
} from '../../agent-e2e/fixtures/egress-fixture.js';
import { startMcpTestServer } from '../../agent-e2e/fixtures/mcp-test-server.js';
import { startWebhookReceiver } from '../../agent-e2e/fixtures/webhook-receiver.js';

async function callTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = new McpClient({
    name: 'agent-e2e-fixture-test',
    version: '1.0.0',
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

function textContent(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> })
    .content;
  return content.map((item) => item.text).join('');
}

describe('agent-e2e fixtures', () => {
  it('mcp test server serves echo + get-sum and records every call', async () => {
    const server = await startMcpTestServer();
    try {
      const echoed = await callTool(server.url, 'echo', { value: 'ping' });
      expect(textContent(echoed)).toBe('ping');

      const summed = await callTool(server.url, 'get-sum', { a: 20, b: 22 });
      expect(textContent(summed)).toBe('42');

      expect(server.calls).toHaveLength(2);
      expect(server.calls[0]).toMatchObject({
        name: 'echo',
        args: { value: 'ping' },
      });
      expect(server.calls[1]).toMatchObject({
        name: 'get-sum',
        args: { a: 20, b: 22 },
      });
      expect(textContent(server.calls[1].result)).toBe('42');
    } finally {
      await server.stop();
    }
  });

  it('webhook receiver captures a POSTed JSON payload', async () => {
    const receiver = await startWebhookReceiver();
    try {
      const response = await fetch(`${receiver.url}/hooks/test`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-run': 'fixture',
        },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(response.status).toBe(200);

      expect(receiver.requests).toHaveLength(1);
      expect(receiver.requests[0]).toMatchObject({
        method: 'POST',
        path: '/hooks/test',
        body: { hello: 'world' },
      });
      expect(receiver.requests[0].headers['content-type']).toContain(
        'application/json',
      );
      expect(receiver.requests[0].headers['x-test-run']).toBe('fixture');
    } finally {
      await receiver.stop();
    }
  });

  it('attachment fixture is deterministic across writes', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-attach-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-attach-'));
    try {
      const first = writeTestAttachment(dirA);
      const second = writeTestAttachment(dirB);
      expect(first.sha256).toBe(second.sha256);
      expect(fs.readFileSync(first.path)).toEqual(fs.readFileSync(second.path));
      expect(fs.statSync(first.path).size).toBe(1024);
    } finally {
      fs.rmSync(dirA, { force: true, recursive: true });
      fs.rmSync(dirB, { force: true, recursive: true });
    }
  });

  it('egress fixture exposes a loopback allowed host and an unresolvable denylisted host', async () => {
    expect(DENYLISTED_EGRESS_HOST.endsWith('.invalid')).toBe(true);
    const server = await startAllowedHostServer();
    try {
      const response = await fetch(`${server.url}/allowed`);
      expect(response.status).toBe(200);
      expect(server.requests).toEqual(['/allowed']);
    } finally {
      await server.stop();
    }
  });
});

// In-process Streamable HTTP MCP server exposing exactly `echo` + `get-sum`.
// Same stateless per-request pattern as the stub in
// apps/core/test/integration/inline-agent-runtime.integration.test.ts.
import http from 'node:http';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { McpCallRecord } from '../types.js';
import { closeServer, listenLoopback } from './loopback-http.js';

export interface McpTestServer {
  /** Streamable HTTP endpoint, e.g. http://127.0.0.1:PORT/mcp */
  url: string;
  /** Every tool invocation, in order, for assertions. */
  calls: McpCallRecord[];
  stop(): Promise<void>;
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
    : undefined;
}

export async function startMcpTestServer(): Promise<McpTestServer> {
  const calls: McpCallRecord[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const mcp = new McpServer({ name: 'agent-e2e-mcp', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        {
          description: 'Echo the provided value back unchanged.',
          inputSchema: { value: z.string() },
        },
        async ({ value }) => {
          const result = { content: [{ type: 'text' as const, text: value }] };
          calls.push({ name: 'echo', args: { value }, result });
          return result;
        },
      );
      mcp.registerTool(
        'get-sum',
        {
          description: 'Return the sum of a and b.',
          inputSchema: { a: z.number(), b: z.number() },
        },
        async ({ a, b }) => {
          const result = {
            content: [{ type: 'text' as const, text: String(a + b) }],
          };
          calls.push({ name: 'get-sum', args: { a, b }, result });
          return result;
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, await readBody(request));
      response.once('close', () => {
        void transport.close();
        void mcp.close();
      });
    })().catch((error) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  const url = `${await listenLoopback(server)}/mcp`;
  return { url, calls, stop: () => closeServer(server) };
}

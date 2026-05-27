import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  IDENTITY_HEADER_NAME,
  computeIdentitySignature,
} from '../../src/identity/identity-header.js';
import { startHttpServer, type RunningHttpServer } from '../../src/server.js';
import { createLogger } from '../../src/logger.js';
import { CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE } from '../../src/privacy/customer-safe-response.js';
import type { ShopifyMcpEnv } from '../../src/env.js';

const SECRET = 'identity-header-unit-test-secret';
let running: RunningHttpServer | undefined;

function env(port: number, requireVerifiedIdentity: boolean): ShopifyMcpEnv {
  return {
    mode: 'dev',
    shopDomain: 'test-shop.myshopify.com',
    clientId: 'test_id',
    clientSecret: 'test_secret',
    apiVersion: '2026-04',
    port,
    refreshLeadTimeMs: 300_000,
    logLevel: 'error',
    logFormat: 'json',
    identity: requireVerifiedIdentity
      ? { mode: 'required', secret: SECRET, maxAgeSec: 60 }
      : { mode: 'optional', secret: SECRET, maxAgeSec: 60 },
    identitySecret: SECRET,
    requireVerifiedIdentity,
    identityMaxAgeSec: 60,
    identityCacheTtlMs: 0,
  };
}

async function connectClient(
  port: number,
  headers: Record<string, string> = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers } },
  );
  const client = new Client({ name: 'identity-mode-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('Shopify MCP HTTP identity mode', () => {
  it('returns a safe tool error instead of a connection failure when verified phone is required but absent', async () => {
    const port = 18182;
    running = await startHttpServer({
      env: env(port, true),
      logger: createLogger({ level: 'error', format: 'json' }),
    });
    const client = await connectClient(port);
    try {
      const result = await client.callTool({
        name: 'get_order',
        arguments: { orderNumber: 'BSS-2847', callerPhone: '+919999999999' },
      });
      const text =
        result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      expect(result.isError).toBe(true);
      expect(text).toBe(CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE);
      expect(text).not.toMatch(
        /Gantry|MCP|config|identity[_ -]?header|X-Caller|privacy[ _-]?guard|PRIVACY_GUARD|signed channel|admin bypass|Shopify Admin|bypass|tool error|error code/i,
      );
    } finally {
      await client.close();
    }
  });

  it('ignores projected identity headers in admin/operator mode', async () => {
    const port = 18183;
    running = await startHttpServer({
      env: env(port, false),
      logger: createLogger({ level: 'error', format: 'json' }),
    });
    const ts = Math.floor(Date.now() / 1000);
    const badSignature = computeIdentitySignature(
      { phone: '+919876543210', ts },
      'wrong-secret',
    );
    const client = await connectClient(port, {
      [IDENTITY_HEADER_NAME]: `phone:+919876543210;ts:${ts};sig:${badSignature}`,
    });
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('lookup_customer');
    } finally {
      await client.close();
    }
  });
});

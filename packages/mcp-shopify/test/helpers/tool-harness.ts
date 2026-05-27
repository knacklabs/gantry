import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TokenManager } from '../../src/auth/token-manager.js';
import { ShopifyClient } from '../../src/shopify/client.js';
import { registerAllTools } from '../../src/tools/index.js';
import type { CustomerIdentityCache } from '../../src/privacy/customer-identity-cache.js';

export type FetchImpl = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface RegisteredTool {
  handler:
    | ((
        args: Record<string, unknown>,
        extra?: unknown,
      ) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
      }>)
    | {
        createTask?: (...args: unknown[]) => unknown;
      };
  inputSchema?: unknown;
}

export interface ToolHarness {
  server: McpServer;
  tokenManager: TokenManager;
  client: ShopifyClient;
  call: <T = unknown>(
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data?: T;
    error?: { code?: string; message: string };
    raw: unknown;
  }>;
}

export interface BuildHarnessOptions {
  identityCache?: CustomerIdentityCache;
  requireVerifiedIdentity?: boolean;
}

export function buildToolHarness(
  fetchImpl: FetchImpl,
  options: BuildHarnessOptions = {},
): ToolHarness {
  const tokenManager = new TokenManager({
    shopDomain: 'test-shop.myshopify.com',
    clientId: 'test_id',
    clientSecret: 'test_secret',
    fetchImpl: fetchImpl as typeof fetch,
    refreshLeadTimeMs: 60_000,
  });
  const client = new ShopifyClient({
    shopDomain: 'test-shop.myshopify.com',
    apiVersion: '2026-04',
    tokenManager,
    fetchImpl: fetchImpl as typeof fetch,
    maxAttempts: 2,
    initialDelayMs: 1,
    maxDelayMs: 4,
  });
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerAllTools(server, client, {
    identityCache: options.identityCache,
    requireVerifiedIdentity: options.requireVerifiedIdentity ?? false,
  });

  const registry = readRegisteredTools(server);

  return {
    server,
    tokenManager,
    client,
    async call<T>(name: string, args: Record<string, unknown>) {
      const tool = registry[name];
      if (!tool) throw new Error(`tool ${name} not registered`);
      const handler = tool.handler;
      if (typeof handler !== 'function') {
        throw new Error(`tool ${name} has no callable handler`);
      }
      const result = await handler(args, {});
      const text = result.content?.[0]?.text ?? '';
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text;
      }
      if (
        result.isError ||
        (raw && typeof raw === 'object' && 'error' in (raw as object))
      ) {
        const err = (raw as { error?: { code: string; message: string } })
          .error;
        if (!err && typeof raw === 'string') {
          return { error: { message: raw }, raw } as {
            data?: T;
            error?: { code?: string; message: string };
            raw: unknown;
          };
        }
        return { error: err, raw } as {
          data?: T;
          error?: { code?: string; message: string };
          raw: unknown;
        };
      }
      return { data: raw as T, raw };
    },
  };
}

function readRegisteredTools(
  server: McpServer,
): Record<string, RegisteredTool> {
  const internal = server as unknown as {
    _registeredTools?: Record<string, RegisteredTool>;
  };
  if (internal._registeredTools) return internal._registeredTools;
  throw new Error('Could not introspect McpServer registered tools');
}

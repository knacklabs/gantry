import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { TokenManager } from './auth/token-manager.js';
import type { ShopifyMcpEnv } from './env.js';
import type { Logger } from './logger.js';
import { CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE } from './privacy/customer-safe-response.js';
import { ShopifyClient } from './shopify/client.js';
import { registerAllTools } from './tools/index.js';
import { CustomerIdentityCache } from './privacy/customer-identity-cache.js';
import {
  IDENTITY_HEADER_NAME,
  verifyIdentityHeader,
} from './identity/identity-header.js';
import { runWithIdentity } from './identity/identity-context.js';

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function parseUrlPath(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    const path = parsed.pathname.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  } catch {
    return null;
  }
}

function errToLog(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      err: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
    };
  }
  return { err: String(err) };
}

export interface BuildMcpServerResult {
  server: McpServer;
  tokenManager: TokenManager;
  client: ShopifyClient;
}

export function buildMcpServer(
  env: ShopifyMcpEnv,
  logger?: Logger,
): BuildMcpServerResult {
  const tokenManager = new TokenManager({
    shopDomain: env.shopDomain,
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    refreshLeadTimeMs: env.refreshLeadTimeMs,
    logger,
  });
  const client = new ShopifyClient({
    shopDomain: env.shopDomain,
    apiVersion: env.apiVersion,
    tokenManager,
    logger,
  });
  const identityCache =
    env.identityCacheTtlMs > 0
      ? new CustomerIdentityCache({ ttlMs: env.identityCacheTtlMs })
      : undefined;
  const server = new McpServer({
    name: 'shopify-mcp',
    version: '0.1.0',
  });
  registerAllTools(server, client, {
    identityCache,
    requireVerifiedIdentity: env.requireVerifiedIdentity,
  });
  return { server, tokenManager, client };
}

export interface StartHttpServerOptions {
  env: ShopifyMcpEnv;
  logger: Logger;
}

export interface RunningHttpServer {
  close: () => Promise<void>;
  tokenManager: TokenManager;
}

interface ReadBodyResult {
  ok: boolean;
  body?: unknown;
  rawLen: number;
  error?: string;
}

async function readRequestBody(req: IncomingMessage): Promise<ReadBodyResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const rawLen = chunks.reduce((acc, c) => acc + c.length, 0);
  if (rawLen === 0) return { ok: true, rawLen: 0, body: undefined };
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { ok: true, rawLen, body: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      rawLen,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function startHttpServer(
  opts: StartHttpServerOptions,
): Promise<RunningHttpServer> {
  const { env, logger } = opts;
  const tokenManager = new TokenManager({
    shopDomain: env.shopDomain,
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    refreshLeadTimeMs: env.refreshLeadTimeMs,
    logger,
  });
  const client = new ShopifyClient({
    shopDomain: env.shopDomain,
    apiVersion: env.apiVersion,
    tokenManager,
    logger,
  });
  const identityCache =
    env.identityCacheTtlMs > 0
      ? new CustomerIdentityCache({ ttlMs: env.identityCacheTtlMs })
      : undefined;

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const path = parseUrlPath(req.url);
      if (path !== '/mcp') {
        if (path === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
        return;
      }
      const headerCheck = env.requireVerifiedIdentity
        ? verifyIdentityHeader(readHeader(req, IDENTITY_HEADER_NAME), {
            secret:
              env.identity.mode === 'disabled'
                ? undefined
                : env.identity.secret,
            maxAgeSec: env.identityMaxAgeSec,
          })
        : ({ kind: 'absent' } as const);
      const safeIdentityErrorBody = JSON.stringify({
        error: {
          message: CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
        },
      });

      if (headerCheck.kind === 'invalid') {
        const isAttackSignal =
          headerCheck.reason === 'BAD_SIGNATURE' ||
          headerCheck.reason === 'STALE_TIMESTAMP' ||
          headerCheck.reason === 'FUTURE_TIMESTAMP';
        const logFn = isAttackSignal ? logger.error : logger.warn;
        logFn(
          { reason: headerCheck.reason },
          'shopify_mcp_identity_header_invalid',
        );
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(safeIdentityErrorBody);
        return;
      }

      const verifiedIdentity =
        env.requireVerifiedIdentity && headerCheck.kind === 'ok'
          ? headerCheck.identity
          : null;

      const bodyResult = await readRequestBody(req);
      if (!bodyResult.ok) {
        logger.warn(
          { rawLen: bodyResult.rawLen, err: bodyResult.error },
          'shopify_mcp_body_parse_failed',
        );
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'malformed_json_body' }));
        return;
      }
      const server = new McpServer({
        name: 'shopify-mcp',
        version: '0.1.0',
      });
      registerAllTools(server, client, {
        identityCache,
        requireVerifiedIdentity: env.requireVerifiedIdentity,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        transport
          .close()
          .catch((err) =>
            logger.warn(errToLog(err), 'shopify_mcp_transport_close_failed'),
          );
        server
          .close()
          .catch((err) =>
            logger.warn(errToLog(err), 'shopify_mcp_server_close_failed'),
          );
      });
      try {
        await runWithIdentity(verifiedIdentity, async () => {
          await server.connect(transport);
          await transport.handleRequest(req, res, bodyResult.body);
        });
      } catch (err) {
        logger.error(errToLog(err), 'shopify_mcp_request_failed');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      }
    },
  );

  await new Promise<void>((resolve) =>
    httpServer.listen(env.port, '127.0.0.1', resolve),
  );

  logger.info(
    {
      port: env.port,
      shopifyMode: env.mode,
      shopDomain: env.shopDomain,
      apiVersion: env.apiVersion,
      identityMode: env.identity.mode,
      identityCacheTtlMs: env.identityCacheTtlMs,
      bootedAt: new Date().toISOString(),
    },
    'shopify_mcp_listening',
  );

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Forcefully drop keep-alive connections so restart is immediate.
        // Without this, long-lived MCP clients can hold the socket open and
        // httpServer.close() can hang for tens of seconds.
        if (typeof httpServer.closeAllConnections === 'function') {
          httpServer.closeAllConnections();
        }
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
    tokenManager,
  };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Pool } from 'pg';
import type { BoondiCrmEnv } from './env.js';
import type { Logger } from './logger.js';
import { createPool } from './db/pool.js';
import { RecordsRepository } from './db/records-repository.js';
import {
  IDENTITY_HEADER_NAME,
  verifyIdentityHeader,
} from './identity/identity-header.js';
import { runWithIdentity } from './identity/identity-context.js';
import { registerAllTools } from './tools/index.js';
import { runManualConversationExtraction } from './watcher/index.js';
import { createAnthropicExtractorLlm } from './extractor/llm-client.js';

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
    return { err: { name: err.name, message: err.message, stack: err.stack } };
  }
  return { err: String(err) };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function verifiedIdentityForRequest(
  req: IncomingMessage,
  env: BoondiCrmEnv,
  logger: Logger,
):
  | { ok: true; identity: ReturnType<typeof verifyIdentityHeader> }
  | { ok: false; status: number; payload: unknown } {
  const headerCheck = env.requireVerifiedIdentity
    ? verifyIdentityHeader(readHeader(req, IDENTITY_HEADER_NAME), {
        secret:
          env.identity.mode === 'disabled' ? undefined : env.identity.secret,
        maxAgeSec: env.identityMaxAgeSec,
      })
    : ({ kind: 'absent' } as const);

  if (headerCheck.kind === 'invalid') {
    const isAttackSignal =
      headerCheck.reason === 'BAD_SIGNATURE' ||
      headerCheck.reason === 'STALE_TIMESTAMP' ||
      headerCheck.reason === 'FUTURE_TIMESTAMP';
    (isAttackSignal ? logger.error : logger.warn)(
      { reason: headerCheck.reason },
      'boondi_crm_identity_header_invalid',
    );
    return {
      ok: false,
      status: 401,
      payload: { error: { code: 'IDENTITY_INVALID' } },
    };
  }

  return { ok: true, identity: headerCheck };
}

interface ReadBodyResult {
  ok: boolean;
  body?: unknown;
  rawLen: number;
  error?: string;
}

async function readRequestBody(req: IncomingMessage): Promise<ReadBodyResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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

export interface StartHttpServerOptions {
  env: BoondiCrmEnv;
  logger: Logger;
  pool?: Pool; // injectable for tests
}

export interface RunningHttpServer {
  close: () => Promise<void>;
  pool: Pool;
  repo: RecordsRepository;
}

export async function startHttpServer(
  opts: StartHttpServerOptions,
): Promise<RunningHttpServer> {
  const { env, logger } = opts;
  const pool = opts.pool ?? createPool(env.databaseUrl, env.dbSchema);
  const repo = new RecordsRepository(pool);

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const path = parseUrlPath(req.url);
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/admin/extract-leads-queries') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const identity = verifiedIdentityForRequest(req, env, logger);
        if (!identity.ok) {
          sendJson(res, identity.status, identity.payload);
          return;
        }
        // The route triggers LLM spend + CRM writes: in required mode an
        // ABSENT identity header must not pass (verifiedIdentityForRequest
        // only rejects forged/stale ones). The production caller always
        // signs; /mcp keeps its own downstream tool-layer enforcement.
        if (env.requireVerifiedIdentity && identity.identity.kind !== 'ok') {
          logger.warn({}, 'boondi_crm_manual_extract_identity_missing');
          sendJson(res, 401, { error: { code: 'IDENTITY_REQUIRED' } });
          return;
        }
        const bodyResult = await readRequestBody(req);
        if (!bodyResult.ok || !bodyResult.body) {
          logger.warn(
            { rawLen: bodyResult.rawLen, err: bodyResult.error },
            'boondi_crm_body_parse_failed',
          );
          sendJson(res, 400, { error: 'malformed_json_body' });
          return;
        }
        const conversationId = (bodyResult.body as { conversationId?: unknown })
          .conversationId;
        if (
          typeof conversationId !== 'string' ||
          !/^conversation:wa:\d+$/.test(conversationId)
        ) {
          sendJson(res, 400, { error: 'invalid_conversation_id' });
          return;
        }
        // Silent zeros when the extractor is unconfigured confused operators
        // (looks identical to "nothing to extract") — surface it as a 503.
        const llm = createAnthropicExtractorLlm(env);
        if (!llm) {
          logger.warn({}, 'boondi_crm_manual_extract_disabled');
          sendJson(res, 503, { error: 'extractor_disabled' });
          return;
        }
        try {
          const stats = await runManualConversationExtraction(
            { env, logger, pool, repo, llm },
            conversationId,
          );
          sendJson(res, 200, { ok: true, stats });
        } catch (err) {
          logger.error(errToLog(err), 'boondi_crm_manual_extract_failed');
          sendJson(res, 500, { error: 'internal_error' });
        }
        return;
      }

      if (path !== '/mcp') {
        res.writeHead(404).end();
        return;
      }

      const identity = verifiedIdentityForRequest(req, env, logger);
      if (!identity.ok) {
        sendJson(res, identity.status, identity.payload);
        return;
      }
      const headerCheck = identity.identity;
      const verifiedIdentity =
        env.requireVerifiedIdentity && headerCheck.kind === 'ok'
          ? headerCheck.identity
          : null;

      const bodyResult = await readRequestBody(req);
      if (!bodyResult.ok) {
        logger.warn(
          { rawLen: bodyResult.rawLen, err: bodyResult.error },
          'boondi_crm_body_parse_failed',
        );
        sendJson(res, 400, { error: 'malformed_json_body' });
        return;
      }

      const server = new McpServer({ name: 'boondi-crm', version: '0.1.0' });
      registerAllTools(server, repo);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        transport
          .close()
          .catch((err) =>
            logger.warn(errToLog(err), 'boondi_crm_transport_close_failed'),
          );
        server
          .close()
          .catch((err) =>
            logger.warn(errToLog(err), 'boondi_crm_server_close_failed'),
          );
      });
      try {
        await runWithIdentity(verifiedIdentity, async () => {
          await server.connect(transport);
          await transport.handleRequest(req, res, bodyResult.body);
        });
      } catch (err) {
        logger.error(errToLog(err), 'boondi_crm_request_failed');
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
      schema: env.dbSchema,
      identityMode: env.identity.mode,
      bootedAt: new Date().toISOString(),
    },
    'boondi_crm_listening',
  );

  return {
    pool,
    repo,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (typeof httpServer.closeAllConnections === 'function') {
          httpServer.closeAllConnections();
        }
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

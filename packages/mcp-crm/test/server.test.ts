import { createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoondiCrmEnv } from '../src/env.js';
import type { Logger } from '../src/logger.js';
import { startHttpServer } from '../src/server.js';
import { makeFakePool } from './helpers/fakes.js';
import { runManualConversationExtraction } from '../src/watcher/index.js';
import { createAnthropicExtractorLlm } from '../src/extractor/llm-client.js';
import { computeIdentitySignature } from '../src/identity/identity-header.js';

vi.mock('../src/watcher/index.js', () => ({
  runManualConversationExtraction: vi.fn(),
}));

vi.mock('../src/extractor/llm-client.js', () => ({
  createAnthropicExtractorLlm: vi.fn(() => ({ complete: vi.fn() })),
}));

const mockedManualExtraction = vi.mocked(runManualConversationExtraction);
const mockedCreateLlm = vi.mocked(createAnthropicExtractorLlm);

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('No TCP port assigned')));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

async function startTestServer(envOverrides: Partial<BoondiCrmEnv> = {}) {
  const port = await freePort();
  const env: BoondiCrmEnv = {
    port,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    dbSchema: 'boondi_crm',
    gantrySchema: 'gantry',
    identity: { mode: 'disabled' },
    requireVerifiedIdentity: false,
    identityMaxAgeSec: 120,
    logLevel: 'fatal',
    logFormat: 'json',
    crmLeadQueryExtractionWatcher: {
      enabled: true,
      pollIntervalMs: 1,
      model: 'test-model',
    },
    reconcileAgentId: 'agent:boondi_support',
    modelAppId: 'default',
    anthropicApiKey: 'test-key',
  };
  Object.assign(env, envOverrides);
  const logger = makeLogger();
  const { pool } = makeFakePool(() => ({ rows: [] }));
  const running = await startHttpServer({ env, logger, pool });
  return {
    env,
    logger,
    pool,
    running,
    url: `http://127.0.0.1:${port}`,
  };
}

function signedEmailHeader(email: string, secret = 'test-secret'): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = computeIdentitySignature({ email, ts }, secret);
  return `email:${email}; ts:${ts}; sig:${sig}`;
}

describe('Boondi CRM admin extraction route', () => {
  let closeCurrent: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (closeCurrent) {
      await closeCurrent();
      closeCurrent = undefined;
    }
  });

  it('rejects non-POST extraction requests without invoking the watcher', async () => {
    const server = await startTestServer();
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/extract-leads-queries`);

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: 'method_not_allowed' });
    expect(mockedManualExtraction).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and invalid conversation ids before extraction', async () => {
    const server = await startTestServer();
    closeCurrent = server.running.close;

    const malformed = await fetch(`${server.url}/admin/extract-leads-queries`, {
      method: 'POST',
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'malformed_json_body' });

    const invalidConversation = await fetch(
      `${server.url}/admin/extract-leads-queries`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'conversation:sl:C123' }),
      },
    );
    expect(invalidConversation.status).toBe(400);
    expect(await invalidConversation.json()).toEqual({
      error: 'invalid_conversation_id',
    });
    expect(mockedManualExtraction).not.toHaveBeenCalled();
  });

  it('runs manual extraction for one WhatsApp conversation', async () => {
    mockedManualExtraction.mockResolvedValueOnce({
      digests: 1,
      extracted: 2,
      created: 1,
      updated: 1,
      skipped: 0,
    });
    const server = await startTestServer();
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/extract-leads-queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'conversation:wa:919654405340',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      stats: { digests: 1, extracted: 2, created: 1, updated: 1, skipped: 0 },
    });
    expect(mockedManualExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ env: server.env, pool: server.pool }),
      'conversation:wa:919654405340',
    );
  });

  it('runs manual extraction when the background CRM watcher is disabled', async () => {
    mockedManualExtraction.mockResolvedValueOnce({
      digests: 1,
      extracted: 1,
      created: 1,
      updated: 0,
      skipped: 0,
    });
    const server = await startTestServer({
      crmLeadQueryExtractionWatcher: {
        enabled: false,
        pollIntervalMs: 30000,
        model: 'haiku',
      },
    });
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/extract-leads-queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'conversation:wa:919654405340',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockedManualExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ env: server.env, pool: server.pool }),
      'conversation:wa:919654405340',
    );
  });

  it('returns 503 extractor_disabled when no model credential is configured', async () => {
    mockedCreateLlm.mockReturnValueOnce(null);
    const server = await startTestServer();
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/extract-leads-queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'conversation:wa:919654405340',
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'extractor_disabled' });
    expect(mockedManualExtraction).not.toHaveBeenCalled();
  });

  it('returns 401 when identity is required and the header is absent', async () => {
    const server = await startTestServer({
      identity: { mode: 'required', secret: 'test-secret', maxAgeSec: 120 },
      requireVerifiedIdentity: true,
    } as Partial<BoondiCrmEnv>);
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/extract-leads-queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'conversation:wa:919654405340',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'IDENTITY_REQUIRED' },
    });
    expect(mockedManualExtraction).not.toHaveBeenCalled();
  });

  it('returns 500 internal_error when extraction throws', async () => {
    mockedManualExtraction.mockRejectedValueOnce(new Error('pg down'));
    const server = await startTestServer();
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/extract-leads-queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'conversation:wa:919654405340',
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });
});

describe('Boondi CRM response comment route', () => {
  let closeCurrent: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (closeCurrent) {
      await closeCurrent();
      closeCurrent = undefined;
    }
  });

  it('requires a verified email identity before saving comments', async () => {
    const server = await startTestServer({
      identity: { mode: 'required', secret: 'test-secret', maxAgeSec: 120 },
      requireVerifiedIdentity: true,
    } as Partial<BoondiCrmEnv>);
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/response-comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'upsert',
        messageId: 'msg_out_1',
        conversationId: 'conversation:wa:919900000001',
        comment: 'Correct this answer.',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'IDENTITY_REQUIRED' },
    });
  });

  it('rejects malformed comment requests before touching storage', async () => {
    const server = await startTestServer({
      identity: { mode: 'required', secret: 'test-secret', maxAgeSec: 120 },
      requireVerifiedIdentity: true,
    } as Partial<BoondiCrmEnv>);
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/response-comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Caller-Identity': signedEmailHeader('admin@boondi.local'),
      },
      body: JSON.stringify({
        action: 'upsert',
        messageId: '',
        conversationId: 'conversation:wa:919900000001',
        comment: '',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('rejects comments for non-outbound or missing Gantry messages', async () => {
    const server = await startTestServer({
      identity: { mode: 'required', secret: 'test-secret', maxAgeSec: 120 },
      requireVerifiedIdentity: true,
    } as Partial<BoondiCrmEnv>);
    closeCurrent = server.running.close;

    const response = await fetch(`${server.url}/admin/response-comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Caller-Identity': signedEmailHeader('admin@boondi.local'),
      },
      body: JSON.stringify({
        action: 'upsert',
        messageId: 'msg_in_1',
        conversationId: 'conversation:wa:919900000001',
        comment: 'Correct this answer.',
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'target_outbound_message_not_found',
    });
  });

  it('saves an admin comment for an outbound Boondi response', async () => {
    const { pool } = makeFakePool((sql, params) => {
      if (sql.includes('FROM gantry.messages')) {
        return { rows: [{ id: 'msg_out_1' }] };
      }
      if (sql.includes('RETURNING')) {
        return {
          rows: [
            {
              message_id: params?.[0],
              conversation_id: params?.[1],
              comment_text: params?.[2],
              author_email: params?.[3],
              created_at: '2026-06-12T01:00:00.000Z',
              updated_at: '2026-06-12T01:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const server = await startTestServer({
      identity: { mode: 'required', secret: 'test-secret', maxAgeSec: 120 },
      requireVerifiedIdentity: true,
    } as Partial<BoondiCrmEnv>);
    await server.running.close();
    const logger = makeLogger();
    const running = await startHttpServer({ env: server.env, logger, pool });
    closeCurrent = running.close;

    const response = await fetch(`${server.url}/admin/response-comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Caller-Identity': signedEmailHeader('admin@boondi.local'),
      },
      body: JSON.stringify({
        action: 'upsert',
        messageId: 'msg_out_1',
        conversationId: 'conversation:wa:919900000001',
        comment: 'Explain pricing before suggesting the hamper.',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      comment: {
        messageId: 'msg_out_1',
        conversationId: 'conversation:wa:919900000001',
        commentText: 'Explain pricing before suggesting the hamper.',
        authorEmail: 'admin@boondi.local',
        createdAt: '2026-06-12T01:00:00.000Z',
        updatedAt: '2026-06-12T01:00:00.000Z',
      },
    });
  });
});

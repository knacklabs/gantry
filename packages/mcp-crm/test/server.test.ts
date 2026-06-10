import { createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoondiCrmEnv } from '../src/env.js';
import type { Logger } from '../src/logger.js';
import { startHttpServer } from '../src/server.js';
import { makeFakePool } from './helpers/fakes.js';
import { runManualConversationExtraction } from '../src/watcher/index.js';
import { createAnthropicExtractorLlm } from '../src/extractor/llm-client.js';

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
    reconcileIntervalMs: 1,
    reconcileAgentId: 'agent:boondi_support',
    modelAppId: 'default',
    extractorModel: 'test-model',
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

  it('runs the live-transcript manual extraction for one WhatsApp conversation', async () => {
    mockedManualExtraction.mockResolvedValueOnce({
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
      stats: { extracted: 2, created: 1, updated: 1, skipped: 0 },
    });
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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-runner-mcp-ipc-'));
  tempRoots.push(root);
  return root;
}

async function waitForRequestId(
  requestDir: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(requestDir)) {
      const files = fs.readdirSync(requestDir).filter((name) => {
        return name.endsWith('.json');
      });
      if (files.length > 0) {
        return path.basename(files[0]!, '.json');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for browser IPC request');
}

function signPayload(
  privateKeyPem: string,
  payload: Record<string, unknown>,
): string {
  return cryptoSign(null, Buffer.from(JSON.stringify(payload)), privateKeyPem)
    .toString('base64')
    .trim();
}

function signPayloadWithAuthToken(
  authToken: string,
  payload: Record<string, unknown>,
): string {
  return createHmac('sha256', authToken)
    .update(Buffer.from(JSON.stringify(payload)))
    .digest('hex');
}

async function loadIpcModule(tempRoot: string, responseVerifyKey: string) {
  vi.resetModules();
  vi.stubEnv('MYCLAW_IPC_DIR', tempRoot);
  vi.stubEnv('MYCLAW_IPC_AUTH_TOKEN', 'mcp-test-auth-token');
  vi.stubEnv('MYCLAW_BROWSER_IPC_AUTH_TOKEN', 'browser-test-auth-token');
  vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', responseVerifyKey);
  vi.stubEnv('MYCLAW_IPC_RESPONSE_KEY_ID', 'mcp-test-response-key-id');
  vi.stubEnv('MYCLAW_CHAT_JID', 'tg:team');
  vi.stubEnv('MYCLAW_GROUP_FOLDER', 'team');
  vi.stubEnv('MYCLAW_ADMIN_MCP_TOOLS_JSON', '[]');
  return import('@core/runner/mcp/ipc.js');
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runner MCP IPC ids', () => {
  it('generates UUID-backed request ids and JSON filenames', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
    const { makeIpcId, makeIpcJsonFilename } =
      await import('@core/runner/mcp/ipc-ids.js');
    const uuidPattern =
      '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

    expect(makeIpcId('service-restart')).toMatch(
      new RegExp(`^service-restart-1778025600000-${uuidPattern}$`),
    );
    expect(makeIpcJsonFilename()).toMatch(
      new RegExp(`^1778025600000-${uuidPattern}\\.json$`),
    );
  });
});

describe('runner MCP browser IPC signature verification', () => {
  it('signs browser requests with the chat-scoped browser IPC token', async () => {
    const tempRoot = makeTempRoot();
    const { publicKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction('status', {});
    const requestId = await waitForRequestId(
      path.join(tempRoot, 'browser-requests'),
    );
    const requestPath = path.join(
      tempRoot,
      'browser-requests',
      `${requestId}.json`,
    );
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const payload = { ...request };
    delete payload.signature;

    expect(request).toMatchObject({
      context: { chatJid: 'tg:team' },
    });
    expect(request.signature).toBe(
      signPayloadWithAuthToken('browser-test-auth-token', payload),
    );
    expect(fileMode(path.dirname(requestPath))).toBe(0o700);
    expect(fileMode(requestPath)).toBe(0o600);

    const responsePath = path.join(
      tempRoot,
      'browser-responses',
      `${requestId}.json`,
    );
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(
      responsePath,
      JSON.stringify({ requestId, ok: false, error: 'done' }),
    );
    await requestPromise;
  });

  it('accepts valid signed browser responses and unlinks consumed response files', async () => {
    const tempRoot = makeTempRoot();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const responseSigningKey = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction('status', {});
    const requestId = await waitForRequestId(
      path.join(tempRoot, 'browser-requests'),
    );

    const payload = {
      ok: true,
      requestId,
      data: { running: true },
    };
    const signature = signPayload(responseSigningKey, payload);
    const responsePath = path.join(
      tempRoot,
      'browser-responses',
      `${requestId}.json`,
    );
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(responsePath, JSON.stringify({ ...payload, signature }));

    await expect(requestPromise).resolves.toEqual({
      ok: true,
      data: { running: true },
    });
    expect(fs.existsSync(responsePath)).toBe(false);
  });

  it('rejects browser responses signed only with the IPC auth token', async () => {
    const tempRoot = makeTempRoot();
    const { publicKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction('status', {});
    const requestId = await waitForRequestId(
      path.join(tempRoot, 'browser-requests'),
    );

    const payload = {
      ok: true,
      requestId,
      data: { running: true },
    };
    const signature = signPayloadWithAuthToken('mcp-test-auth-token', payload);
    const responsePath = path.join(
      tempRoot,
      'browser-responses',
      `${requestId}.json`,
    );
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(responsePath, JSON.stringify({ ...payload, signature }));

    await expect(requestPromise).resolves.toEqual({
      ok: false,
      error: 'Invalid browser response signature',
    });
    expect(fs.existsSync(responsePath)).toBe(false);
  });

  it('fails closed when the browser response payload is tampered after signing', async () => {
    const tempRoot = makeTempRoot();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const responseSigningKey = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction('status', {});
    const requestId = await waitForRequestId(
      path.join(tempRoot, 'browser-requests'),
    );

    const signedPayload = {
      requestId,
      ok: true,
      data: { running: true },
    };
    const signature = signPayload(responseSigningKey, signedPayload);
    const responsePath = path.join(
      tempRoot,
      'browser-responses',
      `${requestId}.json`,
    );
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(
      responsePath,
      JSON.stringify({
        requestId,
        ok: true,
        data: { running: false },
        signature,
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      ok: false,
      error: 'Invalid browser response signature',
    });
  });

  it('fails closed when browser response signature is missing', async () => {
    const tempRoot = makeTempRoot();
    const { publicKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction('status', {});
    const requestId = await waitForRequestId(
      path.join(tempRoot, 'browser-requests'),
    );

    const responsePath = path.join(
      tempRoot,
      'browser-responses',
      `${requestId}.json`,
    );
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(
      responsePath,
      JSON.stringify({
        requestId,
        ok: true,
        data: { running: true },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      ok: false,
      error: 'Invalid browser response signature',
    });
  });

  it('rejects browser responses when request ids do not match the pending request', async () => {
    const tempRoot = makeTempRoot();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const responseSigningKey = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction('status', {});
    const requestId = await waitForRequestId(
      path.join(tempRoot, 'browser-requests'),
    );

    const payload = {
      requestId: 'browser-other',
      ok: true,
      data: { running: true },
    };
    const signature = signPayload(responseSigningKey, payload);
    const responsePath = path.join(
      tempRoot,
      'browser-responses',
      `${requestId}.json`,
    );
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(responsePath, JSON.stringify({ ...payload, signature }));

    await expect(requestPromise).resolves.toEqual({
      ok: false,
      error: 'Mismatched browser response requestId',
    });
  });

  it('removes stale browser requests when the service does not respond before timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
    const tempRoot = makeTempRoot();
    const { publicKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction('status', {});
    const requestDir = path.join(tempRoot, 'browser-requests');
    const requestFiles = fs.readdirSync(requestDir);
    expect(requestFiles).toHaveLength(1);
    const requestPath = path.join(requestDir, requestFiles[0]!);

    await vi.advanceTimersByTimeAsync(30_100);

    await expect(requestPromise).resolves.toEqual({
      ok: false,
      error:
        'Browser IPC timeout after 30s waiting for browser service response',
    });
    expect(fs.existsSync(requestPath)).toBe(false);
  });

  it('uses caller-provided browser timeout for request expiry and stale cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
    const tempRoot = makeTempRoot();
    const { publicKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction(
      'screenshot',
      {},
      { timeoutMs: 120_000 },
    );
    const requestDir = path.join(tempRoot, 'browser-requests');
    const requestFiles = fs.readdirSync(requestDir);
    expect(requestFiles).toHaveLength(1);
    const requestPath = path.join(requestDir, requestFiles[0]!);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8')) as Record<
      string,
      unknown
    >;

    expect(request.expiresAt).toBe('2026-05-06T00:02:00.000Z');

    await vi.advanceTimersByTimeAsync(30_100);
    expect(fs.existsSync(requestPath)).toBe(true);

    await vi.advanceTimersByTimeAsync(90_000);

    await expect(requestPromise).resolves.toEqual({
      ok: false,
      error:
        'Browser IPC timeout after 2 min waiting for browser service response',
    });
    expect(fs.existsSync(requestPath)).toBe(false);
  });

  it('removes stale memory requests when the service does not respond before timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
    const tempRoot = makeTempRoot();
    const { publicKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const { requestMemoryAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestMemoryAction('memory_search', {
      query: 'status',
    });
    const requestDir = path.join(tempRoot, 'memory-requests');
    const requestFiles = fs.readdirSync(requestDir);
    expect(requestFiles).toHaveLength(1);
    const requestPath = path.join(requestDir, requestFiles[0]!);
    expect(fileMode(requestDir)).toBe(0o700);
    expect(fileMode(requestPath)).toBe(0o600);

    await vi.advanceTimersByTimeAsync(15_100);

    await expect(requestPromise).resolves.toEqual({
      ok: false,
      error: 'Timed out waiting for memory service response (15s)',
    });
    expect(fs.existsSync(requestPath)).toBe(false);
  });
});

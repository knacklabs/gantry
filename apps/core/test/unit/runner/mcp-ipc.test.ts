import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];

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
  vi.stubEnv('MYCLAW_CHAT_JID', 'tg:team');
  vi.stubEnv('MYCLAW_GROUP_FOLDER', 'team');
  vi.stubEnv('MYCLAW_ADMIN_MCP_TOOLS_JSON', '[]');
  return import('@core/runner/mcp/ipc.js');
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    const requestPromise = requestBrowserAction('browser_status', {});
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
    const requestPromise = requestBrowserAction('browser_status', {});
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

  it('accepts browser responses signed with the IPC auth token', async () => {
    const tempRoot = makeTempRoot();
    const { publicKey } = generateKeyPairSync('ed25519');
    const responseVerifyKey = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const { requestBrowserAction } = await loadIpcModule(
      tempRoot,
      responseVerifyKey,
    );
    const requestPromise = requestBrowserAction('browser_status', {});
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
      ok: true,
      data: { running: true },
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
    const requestPromise = requestBrowserAction('browser_status', {});
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
    const requestPromise = requestBrowserAction('browser_status', {});
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
    const requestPromise = requestBrowserAction('browser_status', {});
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
});

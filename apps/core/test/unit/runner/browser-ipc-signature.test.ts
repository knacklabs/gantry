import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIpcResponseSigningKeyPair } from '@core/infrastructure/ipc/response-signing.js';
import { signIpcResponsePayload } from '@core/infrastructure/ipc/response-signing.js';
import { writeBrowserIpcResponse } from '@core/runtime/ipc-browser-handler.js';

describe('browser MCP IPC response signatures', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-browser-ipc-'));
    tempRoots.push(root);
    return root;
  }

  function stubRunnerEnv(root = tempRoot()): void {
    vi.stubEnv('MYCLAW_IPC_DIR', path.join(root, 'main_agent'));
    vi.stubEnv('MYCLAW_GROUP_FOLDER', 'main_agent');
    vi.stubEnv('MYCLAW_CHAT_JID', 'tg:test');
    vi.stubEnv('MYCLAW_ADMIN_MCP_TOOLS_JSON', '[]');
  }

  it('accepts host-written signed browser lifecycle responses', async () => {
    const root = tempRoot();
    const ipcDir = path.join(root, 'main_agent');
    const keys = createIpcResponseSigningKeyPair();
    vi.stubEnv('MYCLAW_IPC_DIR', ipcDir);
    vi.stubEnv('MYCLAW_IPC_AUTH_TOKEN', 'test-token');
    vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', keys.publicKeyPem);
    vi.stubEnv('MYCLAW_GROUP_FOLDER', 'main_agent');
    vi.stubEnv('MYCLAW_CHAT_JID', 'tg:test');
    vi.stubEnv('MYCLAW_ADMIN_MCP_TOOLS_JSON', '[]');

    const { requestBrowserAction } = await import('@core/runner/mcp/ipc.js');

    const responder = (async () => {
      const requestDir = path.join(ipcDir, 'browser-requests');
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(requestDir)) {
          const [file] = fs
            .readdirSync(requestDir)
            .filter((entry) => entry.endsWith('.json'));
          if (file) {
            const request = JSON.parse(
              fs.readFileSync(path.join(requestDir, file), 'utf-8'),
            );
            writeBrowserIpcResponse(
              root,
              'main_agent',
              {
                requestId: request.requestId,
                ok: true,
                data: { running: true },
              },
              keys.privateKeyPem,
            );
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for browser request');
    })();

    const response = await requestBrowserAction('browser_status', {});
    await responder;

    expect(response).toEqual({
      ok: true,
      data: { running: true },
    });
  });

  it('accepts signed responses when only the response verify key is configured', async () => {
    const root = tempRoot();
    const ipcDir = path.join(root, 'main_agent');
    const keys = createIpcResponseSigningKeyPair();
    vi.stubEnv('MYCLAW_IPC_DIR', ipcDir);
    vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', keys.publicKeyPem);
    vi.stubEnv('MYCLAW_GROUP_FOLDER', 'main_agent');
    vi.stubEnv('MYCLAW_CHAT_JID', 'tg:test');
    vi.stubEnv('MYCLAW_ADMIN_MCP_TOOLS_JSON', '[]');

    const { hasValidIpcResponseSignature } =
      await import('@core/runner/mcp/ipc.js');
    const payload = { ok: true, requestId: 'browser-1' };
    const signature = signIpcResponsePayload(keys.privateKeyPem, payload);

    expect(
      hasValidIpcResponseSignature({ ...payload, signature }, payload),
    ).toBe(true);
  });

  it('rejects tampered response payloads', async () => {
    const keys = createIpcResponseSigningKeyPair();
    stubRunnerEnv();
    vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', keys.publicKeyPem);
    const { hasValidIpcResponseSignature } =
      await import('@core/runner/mcp/ipc.js');
    const signedPayload = { ok: true, requestId: 'browser-1' };
    const signature = signIpcResponsePayload(keys.privateKeyPem, signedPayload);
    const tamperedPayload = {
      ok: true,
      requestId: 'browser-1',
      data: { running: true },
    };

    expect(
      hasValidIpcResponseSignature(
        { ...tamperedPayload, signature },
        tamperedPayload,
      ),
    ).toBe(false);
  });

  it('rejects missing signatures, wrong keys, and unset verify keys', async () => {
    const keys = createIpcResponseSigningKeyPair();
    const wrongKeys = createIpcResponseSigningKeyPair();
    const payload = { ok: true, requestId: 'browser-1' };
    const signature = signIpcResponsePayload(keys.privateKeyPem, payload);

    stubRunnerEnv();
    vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', keys.publicKeyPem);
    let ipc = await import('@core/runner/mcp/ipc.js');
    expect(ipc.hasValidIpcResponseSignature(payload, payload)).toBe(false);

    vi.resetModules();
    stubRunnerEnv();
    vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', wrongKeys.publicKeyPem);
    ipc = await import('@core/runner/mcp/ipc.js');
    expect(
      ipc.hasValidIpcResponseSignature({ ...payload, signature }, payload),
    ).toBe(false);

    vi.resetModules();
    vi.unstubAllEnvs();
    stubRunnerEnv();
    ipc = await import('@core/runner/mcp/ipc.js');
    expect(
      ipc.hasValidIpcResponseSignature({ ...payload, signature }, payload),
    ).toBe(false);
  });
});

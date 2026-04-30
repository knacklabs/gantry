import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/runtime/browser-capability.js', () => ({
  DEFAULT_BROWSER_PROFILE_NAME: 'default',
  ensureBrowserReady: vi.fn(async () => ({ ok: true, status: 'launched' })),
  closeBrowser: vi.fn(async () => ({ ok: true, closed: true })),
  getBrowserStatus: vi.fn(() => ({ running: true })),
  listBrowserProfiles: vi.fn(async () => [
    {
      name: 'default',
      created_at: '2024-01-01T00:00:00.000Z',
      last_used: '2024-01-01T00:00:00.000Z',
      cdp_port: 9222,
      auth_markers: [],
      has_state: true,
      running: false,
      cdpReady: false,
    },
  ]),
}));

vi.mock('@core/runtime/browser-profiles.js', () => ({
  createProfile: vi.fn(() => ({
    name: 'default',
    statePath: '/tmp/browser-state',
    metadata: {
      created_at: '2024-01-01T00:00:00.000Z',
      last_used: '2024-01-01T00:00:00.000Z',
      cdp_port: 9222,
      auth_markers: [],
    },
  })),
  summarizeBrowserProfileState: vi.fn(() => ({
    hasState: false,
    authMarkers: [],
  })),
}));

import { BrowserIpcAction } from '@myclaw/contracts';

import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from '@core/runtime/ipc-browser-handler.js';
import {
  ensureBrowserReady,
  getBrowserStatus,
} from '@core/runtime/browser-capability.js';
import { verifyIpcResponseAuthPayload } from '@core/infrastructure/ipc/response-signing.js';

describe('ipc-browser-handler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-browser-handler-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('blocks main-only browser actions for non-main groups', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1',
        action: 'browser_status',
        payload: {},
      },
      { sourceGroup: 'child', isMain: false },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('restricted to the main group');
  });

  it('dispatches browser actions via explicit handlers', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2',
        action: 'browser_launch',
        payload: {
          profile_name: 'default',
          headless: true,
        },
      },
      { sourceGroup: 'main', isMain: true },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserReady).toHaveBeenCalledTimes(1);
    expect(ensureBrowserReady).toHaveBeenCalledWith({
      profileName: 'default',
      headless: true,
      keepAliveMs: undefined,
    });
  });

  it('returns unsupported error for unknown browser action', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-3',
        action: 'not-real-action' as BrowserIpcAction,
        payload: {},
      },
      { sourceGroup: 'main', isMain: true },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unsupported browser action');
  });

  it('writes browser response files atomically', () => {
    writeBrowserIpcResponse(tempDir, 'grp', {
      requestId: 'req-4',
      ok: true,
      data: { running: true },
    });

    const responsePath = path.join(
      tempDir,
      'grp',
      'browser-responses',
      'req-4.json',
    );
    const payload = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    expect(payload).toEqual({
      requestId: 'req-4',
      ok: true,
      data: { running: true },
    });
    expect(getBrowserStatus).not.toHaveBeenCalled();
  });

  it('signs browser responses with the MCP client verification shape', () => {
    const keys = createIpcResponseSigningKeyPair();

    writeBrowserIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'req-5',
        ok: true,
        data: { running: true },
      },
      keys.privateKeyPem,
    );

    const responsePath = path.join(
      tempDir,
      'grp',
      'browser-responses',
      'req-5.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    const runnerVerificationPayload = {
      ok: true,
      requestId: 'req-5',
      data: { running: true },
    };

    expect(
      verifyIpcResponsePayload(
        keys.publicKeyPem,
        runnerVerificationPayload,
        response.signature,
      ),
    ).toBe(true);
  });

  it('signs browser responses with deterministic IPC auth when provided', () => {
    writeBrowserIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'req-5',
        ok: true,
        data: { running: true },
      },
      undefined,
      'thread-ipc-auth-token',
    );

    const responsePath = path.join(
      tempDir,
      'grp',
      'browser-responses',
      'req-5.json',
    );
    const raw = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    const payload = {
      ok: true,
      requestId: 'req-5',
      data: { running: true },
    };

    expect(raw.signature).toEqual(expect.any(String));
    expect(
      verifyIpcResponseAuthPayload(
        'thread-ipc-auth-token',
        payload,
        raw.signature,
      ),
    ).toBe(true);
  });
});

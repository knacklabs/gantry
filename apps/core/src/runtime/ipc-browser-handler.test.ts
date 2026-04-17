import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./browser-manager.js', () => ({
  DEFAULT_BROWSER_PROFILE_NAME: 'default',
  launchBrowser: vi.fn(async () => ({ ok: true, status: 'launched' })),
  closeBrowser: vi.fn(async () => ({ ok: true, closed: true })),
  getBrowserStatus: vi.fn(() => ({ running: true })),
}));

vi.mock('./browser-profiles.js', () => ({
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
}));

import { BrowserIpcAction } from '@myclaw/contracts';

import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from './ipc-browser-handler.js';
import { getBrowserStatus, launchBrowser } from './browser-manager.js';

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
          cdp_port: 9222,
        },
      },
      { sourceGroup: 'main', isMain: true },
    );

    expect(response.ok).toBe(true);
    expect(launchBrowser).toHaveBeenCalledTimes(1);
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
});

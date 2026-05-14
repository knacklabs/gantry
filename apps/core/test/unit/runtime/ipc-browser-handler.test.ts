import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/runtime/browser-capability.js', () => ({
  DEFAULT_BROWSER_PROFILE_NAME: 'default',
  ensureBrowserReady: vi.fn(async () => ({ ok: true, status: 'launched' })),
  closeBrowser: vi.fn(async () => ({ ok: true, closed: true })),
  getBrowserStatus: vi.fn(() => ({
    profile: 'c-child-abc123abc123',
    profileName: 'c-child-abc123abc123',
    running: true,
    cdpReady: true,
    cdpUrl: 'http://127.0.0.1:9222',
    port: 9222,
    pid: 123,
    targetId: 'target-1',
  })),
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
  isValidBrowserProfileName: vi.fn((name: string) =>
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name),
  ),
}));

vi.mock('@core/runtime/browser-cdp-targets.js', () => ({
  ensureBrowserTarget: vi.fn(async () => 'target-1'),
  activateBrowserTarget: vi.fn(async () => undefined),
  foregroundBrowserTarget: vi.fn(async () => undefined),
}));

import type { BrowserBackendAction } from '../../../src/shared/browser-backend-actions.js';

import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from '@core/runtime/ipc-browser-handler.js';
import {
  closeBrowser,
  ensureBrowserReady,
  getBrowserStatus,
} from '@core/runtime/browser-capability.js';
import { resetBrowserUsageGovernorForTests } from '@core/runtime/browser-usage-governor.js';
import {
  ensureBrowserTarget,
  foregroundBrowserTarget,
} from '@core/runtime/browser-cdp-targets.js';
function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('ipc-browser-handler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-browser-handler-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetBrowserUsageGovernorForTests();
  });

  it('allows conversation-scoped groups to inspect browser status', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1',
        action: 'status',
        payload: {},
      },
      {
        sourceAgentFolder: 'child',
        browserProfileName: 'c-child-abc123abc123',
      },
    );

    expect(response.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-child-abc123abc123');
    expect(response.data).toMatchObject({
      profileName: 'c-child-abc123abc123',
      running: true,
      cdpReady: true,
    });
    expect(response.data).not.toHaveProperty('cdpUrl');
    expect(response.data).not.toHaveProperty('port');
    expect(response.data).not.toHaveProperty('pid');
    expect(response.data).not.toHaveProperty('targetId');
    expect(ensureBrowserReady).not.toHaveBeenCalled();
  });

  it('ignores conversation-scoped profile overrides and uses the host-derived profile', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1a',
        action: 'status',
        payload: {
          profile_name: 'c-child-other123456',
        },
      },
      {
        sourceAgentFolder: 'child',
        browserProfileName: 'c-child-abc123abc123',
      },
    );

    expect(response.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-child-abc123abc123');
  });

  it('prevents agents from switching to another browser profile', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1b',
        action: 'status',
        payload: { profile_name: 'default' },
      },
      {
        sourceAgentFolder: 'child',
        browserProfileName: 'c-child-abc123abc123',
      },
    );

    expect(response.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-child-abc123abc123');
  });

  it('ignores forged top-level browser profile scope from child IPC', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1d',
        action: 'status',
        payload: {
          profile_name: 'c-child-other123456',
        },
        browserProfileName: 'c-child-other123456',
      } as never,
      {
        sourceAgentFolder: 'child',
        browserProfileName: 'c-child-abc123abc123',
      },
    );

    expect(response.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-child-abc123abc123');
  });

  it('dispatches browser tools through the direct backend after lazy launch', async () => {
    const callBrowserTool = vi.fn(async () => ({ content: 'tool-result' }));
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1c',
        action: 'navigate',
        payload: { url: 'https://example.test' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserReady).toHaveBeenCalledWith({
      profileName: 'c-main-abc123abc123',
      deadlineAtMs: undefined,
    });
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        fileAccessRoot: expect.stringContaining('/sessions/main/extra'),
        toolName: 'navigate',
        arguments: { url: 'https://example.test' },
      }),
    );
    expect(response.data).toEqual({ content: 'tool-result' });
  });

  it('publishes browser activity events for scheduled job browser calls', async () => {
    const callBrowserTool = vi.fn(async () => ({ content: 'tool-result' }));
    const publishBrowserJobActivity = vi.fn(async () => undefined);
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-job-browser',
        action: 'navigate',
        payload: { url: 'https://example.test' },
        jobId: 'job-1',
        runId: 'run-1',
        publicToolName: 'browser_act',
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        publishBrowserJobActivity,
      },
    );

    expect(response.ok).toBe(true);
    expect(publishBrowserJobActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        runId: 'run-1',
        tool: 'Browser',
        publicToolName: 'browser_act',
        action: 'navigate',
        satisfiesRequiredTool: true,
        ok: true,
        normalizedSite: 'example.test',
      }),
    );
  });

  it('does not satisfy required Browser from backend-only job browser calls', async () => {
    const callBrowserTool = vi.fn(async () => ({ content: 'tool-result' }));
    const publishBrowserJobActivity = vi.fn(async () => undefined);
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-job-browser-private-only',
        action: 'navigate',
        payload: { url: 'https://example.test' },
        jobId: 'job-1',
        runId: 'run-1',
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        publishBrowserJobActivity,
      },
    );

    expect(response.ok).toBe(true);
    expect(publishBrowserJobActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'Browser',
        action: 'navigate',
        publicToolName: undefined,
        satisfiesRequiredTool: false,
      }),
    );
  });

  it('satisfies required Browser for browser_open only when it navigates', async () => {
    const callBrowserTool = vi.fn(async () => ({ content: 'tool-result' }));
    const publishBrowserJobActivity = vi.fn(async () => undefined);

    await processBrowserIpcRequest(
      {
        requestId: 'req-job-browser-open',
        action: 'open',
        payload: {},
        jobId: 'job-1',
        runId: 'run-1',
        publicToolName: 'browser_open',
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        publishBrowserJobActivity,
      },
    );
    await processBrowserIpcRequest(
      {
        requestId: 'req-job-browser-open-url',
        action: 'navigate',
        payload: { url: 'https://example.test' },
        jobId: 'job-1',
        runId: 'run-1',
        publicToolName: 'browser_open',
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        publishBrowserJobActivity,
      },
    );

    expect(publishBrowserJobActivity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: 'open',
        publicToolName: 'browser_open',
        satisfiesRequiredTool: false,
      }),
    );
    expect(publishBrowserJobActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'navigate',
        publicToolName: 'browser_open',
        satisfiesRequiredTool: true,
      }),
    );
  });

  it('keeps browser usage policy audit-only when enabled in audit mode', async () => {
    const callBrowserTool = vi.fn(async () => ({ content: 'tool-result' }));
    const context = {
      sourceAgentFolder: 'main',
      browserProfileName: 'c-main-abc123abc123',
      browserIpcAuthorized: true,
      callBrowserTool,
      getBrowserUsageSettings: () => ({
        enabled: true,
        mode: 'audit' as const,
        windowMs: 60_000,
        maxActionsPerWindow: 1,
        maxConcurrentPerSite: 1,
        overrides: {},
      }),
    };

    const first = await processBrowserIpcRequest(
      {
        requestId: 'req-audit-1',
        action: 'navigate',
        payload: { url: 'https://first.example.test/a' },
      },
      context,
    );
    const second = await processBrowserIpcRequest(
      {
        requestId: 'req-audit-2',
        action: 'navigate',
        payload: { url: 'https://second.example.test/b' },
      },
      context,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(callBrowserTool).toHaveBeenCalledTimes(2);
  });

  it('enforces neutral browser usage limits only when configured', async () => {
    const callBrowserTool = vi.fn(async () => ({ content: 'tool-result' }));
    const context = {
      sourceAgentFolder: 'main',
      browserProfileName: 'c-main-abc123abc123',
      browserIpcAuthorized: true,
      callBrowserTool,
      getBrowserUsageSettings: () => ({
        enabled: true,
        mode: 'enforce' as const,
        windowMs: 60_000,
        maxActionsPerWindow: 1,
        maxConcurrentPerSite: 1,
        overrides: {},
      }),
    };

    const first = await processBrowserIpcRequest(
      {
        requestId: 'req-enforce-1',
        action: 'navigate',
        payload: { url: 'https://first.example.test/a' },
      },
      context,
    );
    const second = await processBrowserIpcRequest(
      {
        requestId: 'req-enforce-2',
        action: 'navigate',
        payload: { url: 'https://second.example.test/b' },
      },
      context,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('Browser usage policy warning');
    expect(callBrowserTool).toHaveBeenCalledTimes(1);
  });

  it('checks browser authorization before metering usage', async () => {
    const callBrowserTool = vi.fn(async () => ({ content: 'tool-result' }));
    const usageSettings = {
      enabled: true,
      mode: 'enforce' as const,
      windowMs: 60_000,
      maxActionsPerWindow: 1,
      maxConcurrentPerSite: 1,
      overrides: {},
    };
    const getBrowserUsageSettings = vi.fn(() => usageSettings);

    const unauthorized = await processBrowserIpcRequest(
      {
        requestId: 'req-unauthorized-before-metering',
        action: 'navigate',
        payload: { url: 'https://first.example.test/a' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: false,
        callBrowserTool,
        getBrowserUsageSettings,
      },
    );
    const authorized = await processBrowserIpcRequest(
      {
        requestId: 'req-authorized-after-stale-request',
        action: 'navigate',
        payload: { url: 'https://second.example.test/b' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        getBrowserUsageSettings,
      },
    );

    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.error).toContain(
      'Select the canonical Browser capability',
    );
    expect(authorized.ok).toBe(true);
    expect(getBrowserUsageSettings).toHaveBeenCalledTimes(1);
    expect(callBrowserTool).toHaveBeenCalledTimes(1);
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'navigate' }),
    );
  });

  it('does not let usage enforcement block browser status or close', async () => {
    const context = {
      sourceAgentFolder: 'main',
      browserProfileName: 'c-main-abc123abc123',
      browserIpcAuthorized: true,
      callBrowserTool: vi.fn(async () => ({ content: 'tool-result' })),
      getBrowserUsageSettings: () => ({
        enabled: true,
        mode: 'enforce' as const,
        windowMs: 60_000,
        maxActionsPerWindow: 1,
        maxConcurrentPerSite: 1,
        overrides: {},
      }),
    };

    const navigate = await processBrowserIpcRequest(
      {
        requestId: 'req-enforce-navigate',
        action: 'navigate',
        payload: { url: 'https://first.example.test/a' },
      },
      context,
    );
    const status = await processBrowserIpcRequest(
      {
        requestId: 'req-enforce-status',
        action: 'status',
        payload: {},
      },
      context,
    );
    const close = await processBrowserIpcRequest(
      {
        requestId: 'req-enforce-close',
        action: 'close',
        payload: {},
      },
      context,
    );

    expect(navigate.ok).toBe(true);
    expect(status.ok).toBe(true);
    expect(close.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-main-abc123abc123');
    expect(closeBrowser).toHaveBeenCalledWith('c-main-abc123abc123');
  });

  it('meters URL-less actions against the backend current tab after in-page navigation', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValue({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'content-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async ({ toolName }) => {
      if (toolName === 'tabs') {
        return {
          structuredContent: {
            tabs: [
              {
                index: 0,
                current: true,
                url: 'https://blocked.example.com/account',
              },
            ],
          },
        };
      }
      return { content: 'tool-result' };
    });
    const context = {
      sourceAgentFolder: 'main',
      browserProfileName: 'c-main-abc123abc123',
      browserIpcAuthorized: true,
      callBrowserTool,
      getBrowserUsageSettings: () => ({
        enabled: true,
        mode: 'audit' as const,
        windowMs: 60_000,
        maxActionsPerWindow: 120,
        maxConcurrentPerSite: 1,
        overrides: {
          'example.com': {
            mode: 'enforce' as const,
            maxActionsPerWindow: 1,
          },
        },
      }),
    };

    const navigate = await processBrowserIpcRequest(
      {
        requestId: 'req-cross-site-navigate',
        action: 'navigate',
        payload: { url: 'https://safe.example.org/start' },
      },
      context,
    );
    const firstClick = await processBrowserIpcRequest(
      {
        requestId: 'req-cross-site-click',
        action: 'click',
        payload: { target: 'button-ref' },
      },
      context,
    );
    const secondClick = await processBrowserIpcRequest(
      {
        requestId: 'req-cross-site-click-again',
        action: 'type',
        payload: { target: 'input-ref', text: 'hello' },
      },
      context,
    );

    expect(navigate.ok).toBe(true);
    expect(firstClick.ok).toBe(true);
    expect(secondClick.ok).toBe(false);
    expect(secondClick.error).toContain('Browser usage policy warning');
    expect(callBrowserTool.mock.calls.map((call) => call[0].toolName)).toEqual([
      'navigate',
      'tabs',
      'click',
      'tabs',
    ]);
  });

  it('ignores forged tabs URLs unless creating a new tab', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValue({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'content-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async () => ({
      structuredContent: {
        tabs: [
          {
            index: 0,
            current: true,
            url: 'https://blocked.example.com/account',
          },
        ],
      },
    }));
    const context = {
      sourceAgentFolder: 'main',
      browserProfileName: 'c-main-abc123abc123',
      browserIpcAuthorized: true,
      callBrowserTool,
      getBrowserUsageSettings: () => ({
        enabled: true,
        mode: 'enforce' as const,
        windowMs: 60_000,
        maxActionsPerWindow: 1,
        maxConcurrentPerSite: 1,
        overrides: {},
      }),
    };

    const list = await processBrowserIpcRequest(
      {
        requestId: 'req-tabs-list',
        action: 'tabs',
        payload: { action: 'list' },
      },
      context,
    );
    const select = await processBrowserIpcRequest(
      {
        requestId: 'req-tabs-select-forged-url',
        action: 'tabs',
        payload: {
          action: 'select',
          index: 0,
          url: 'https://safe.example.org/',
        },
      },
      context,
    );

    expect(list.ok).toBe(true);
    expect(select.ok).toBe(false);
    expect(select.error).toContain('Browser usage policy warning');
    expect(callBrowserTool.mock.calls.map((call) => call[0].toolName)).toEqual([
      'tabs',
      'tabs',
      'tabs',
    ]);
  });

  it('fails closed when enforce mode cannot verify a URL-less action site', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValue({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'content-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async ({ toolName }) => {
      if (toolName === 'tabs') throw new Error('tabs unavailable');
      return { content: 'clicked' };
    });

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-unverified-active-site',
        action: 'click',
        payload: { target: 'button-ref' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        getBrowserUsageSettings: () => ({
          enabled: true,
          mode: 'enforce' as const,
          windowMs: 60_000,
          maxActionsPerWindow: 120,
          maxConcurrentPerSite: 1,
          overrides: {},
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'Browser usage policy could not verify the active page site',
    );
    expect(callBrowserTool).toHaveBeenCalledTimes(1);
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'tabs' }),
    );
  });

  it('fails closed when enforce mode sees an unnormalizable active tab URL', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValue({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'content-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async ({ toolName }) => {
      if (toolName === 'tabs') {
        return {
          structuredContent: {
            tabs: [
              {
                index: 0,
                current: true,
                url: 'chrome://settings/',
              },
            ],
          },
        };
      }
      return { content: 'clicked' };
    });

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-unnormalizable-active-site',
        action: 'click',
        payload: { target: 'button-ref' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        getBrowserUsageSettings: () => ({
          enabled: true,
          mode: 'enforce' as const,
          windowMs: 60_000,
          maxActionsPerWindow: 120,
          maxConcurrentPerSite: 1,
          overrides: {},
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('not a normalizable site');
    expect(callBrowserTool).toHaveBeenCalledTimes(1);
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'tabs' }),
    );
  });

  it('foregrounds the content target immediately before pointer action dispatch', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    vi.mocked(ensureBrowserTarget).mockResolvedValueOnce('content-target');
    const callBrowserTool = vi.fn(async () => ({ content: 'clicked' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-pointer',
        action: 'click',
        payload: { target: 'button-ref' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 2_000,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserTarget).toHaveBeenCalledWith(9333, {
      deadlineAtMs: expect.any(Number),
    });
    expect(foregroundBrowserTarget).toHaveBeenCalledWith(
      9333,
      'content-target',
      {
        deadlineAtMs: expect.any(Number),
      },
    );
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'click',
        session: expect.objectContaining({ port: 9333 }),
        timeoutMs: expect.any(Number),
      }),
    );
    expect(
      vi.mocked(foregroundBrowserTarget).mock.invocationCallOrder[0],
    ).toBeLessThan(callBrowserTool.mock.invocationCallOrder[0]);
  });

  it('foregrounds hover and screenshot actions before backend dispatch', async () => {
    vi.mocked(ensureBrowserReady)
      .mockResolvedValueOnce({
        profile: 'c-main-abc123abc123',
        profileName: 'c-main-abc123abc123',
        running: true,
        cdpReady: true,
        port: 9333,
        targetId: 'stale-target',
        headless: false,
      })
      .mockResolvedValueOnce({
        profile: 'c-main-abc123abc123',
        profileName: 'c-main-abc123abc123',
        running: true,
        cdpReady: true,
        port: 9333,
        targetId: 'stale-target',
        headless: false,
      });
    vi.mocked(ensureBrowserTarget)
      .mockResolvedValueOnce('hover-target')
      .mockResolvedValueOnce('screenshot-target');
    const callBrowserTool = vi.fn(async ({ toolName }) => ({
      content: toolName,
    }));

    const hoverResponse = await processBrowserIpcRequest(
      {
        requestId: 'req-hover',
        action: 'hover',
        payload: { target: 'button-ref' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 2_000,
      },
    );
    const screenshotResponse = await processBrowserIpcRequest(
      {
        requestId: 'req-screenshot',
        action: 'screenshot',
        payload: {},
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 2_000,
      },
    );

    expect(hoverResponse.ok).toBe(true);
    expect(screenshotResponse.ok).toBe(true);
    expect(foregroundBrowserTarget).toHaveBeenNthCalledWith(
      1,
      9333,
      'hover-target',
      { deadlineAtMs: expect.any(Number) },
    );
    expect(foregroundBrowserTarget).toHaveBeenNthCalledWith(
      2,
      9333,
      'screenshot-target',
      { deadlineAtMs: expect.any(Number) },
    );
    expect(callBrowserTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toolName: 'hover' }),
    );
    expect(callBrowserTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toolName: 'screenshot' }),
    );
    expect(
      vi.mocked(foregroundBrowserTarget).mock.invocationCallOrder[0],
    ).toBeLessThan(callBrowserTool.mock.invocationCallOrder[0]);
    expect(
      vi.mocked(foregroundBrowserTarget).mock.invocationCallOrder[1],
    ).toBeLessThan(callBrowserTool.mock.invocationCallOrder[1]);
  });

  it('keeps other pointer actions covered by foregrounding before dispatch', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    vi.mocked(ensureBrowserTarget).mockResolvedValueOnce('content-target');
    const callBrowserTool = vi.fn(async () => ({ content: 'dragged' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-drag',
        action: 'drag',
        payload: { target: 'source', target2: 'destination' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 2_000,
      },
    );

    expect(response.ok).toBe(true);
    expect(foregroundBrowserTarget).toHaveBeenCalledWith(
      9333,
      'content-target',
      {
        deadlineAtMs: expect.any(Number),
      },
    );
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'drag' }),
    );
  });

  it('fails closed before backend dispatch when foregrounding exceeds the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    vi.mocked(ensureBrowserTarget).mockResolvedValueOnce('content-target');
    vi.mocked(foregroundBrowserTarget).mockImplementationOnce(async () => {
      vi.setSystemTime(1_101);
    });
    const callBrowserTool = vi.fn(async () => ({ content: 'clicked' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-foreground-deadline',
        action: 'click',
        payload: { target: 'button-ref' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 100,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Browser IPC deadline exceeded');
    expect(callBrowserTool).not.toHaveBeenCalled();
  });

  it('does not foreground non-pointer non-screenshot backend actions', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    vi.mocked(ensureBrowserTarget).mockResolvedValueOnce('content-target');
    const callBrowserTool = vi.fn(async () => ({ content: 'navigated' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-navigate-no-foreground',
        action: 'navigate',
        payload: { url: 'https://example.test' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(true);
    expect(foregroundBrowserTarget).not.toHaveBeenCalled();
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'navigate' }),
    );
  });

  it('uses signed IPC deadline ahead of reconstructed timeout budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    vi.mocked(ensureBrowserTarget).mockResolvedValueOnce('content-target');
    const callBrowserTool = vi.fn(async () => ({ content: 'clicked' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-signed-deadline',
        action: 'click',
        payload: { target: 'button-ref' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 10_000,
        deadlineAtMs: 5_000,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserTarget).toHaveBeenCalledWith(9333, {
      deadlineAtMs: 5_000,
    });
    expect(foregroundBrowserTarget).toHaveBeenCalledWith(
      9333,
      'content-target',
      {
        deadlineAtMs: 5_000,
      },
    );
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 4_000,
      }),
    );
  });

  it('resizes browser viewport after ensuring a page target exists', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async () => ({ content: 'backend-resized' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-resize-headed',
        action: 'resize',
        payload: { width: 1280, height: 720 },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 5_000,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserTarget).toHaveBeenCalledWith(9333, {
      deadlineAtMs: expect.any(Number),
    });
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'resize',
        arguments: { width: 1280, height: 720 },
        timeoutMs: expect.any(Number),
      }),
    );
    expect(response.data).toEqual({
      content: [{ type: 'text', text: 'Browser window resized to 1280x720.' }],
    });
  });

  it('clamps oversized browser resize dimensions before dispatch', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async () => ({ content: 'backend-resized' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-resize-headed-oversized',
        action: 'resize',
        payload: { width: 12_000, height: 20_000 },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserTarget).toHaveBeenCalledWith(9333);
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'resize',
        arguments: { width: 8192, height: 8192 },
      }),
    );
    expect(response.data).toEqual({
      content: [{ type: 'text', text: 'Browser window resized to 8192x8192.' }],
    });
  });

  it('fails resize when the backend reports an error result', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Cannot resize viewport.' }],
      isError: true,
    }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-resize-error',
        action: 'resize',
        payload: { width: 1280, height: 720 },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Cannot resize viewport.');
  });

  it('passes the remaining browser IPC budget to CDP activation and backend dispatch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    vi.mocked(ensureBrowserTarget).mockImplementationOnce(async () => {
      vi.setSystemTime(1_100);
      return 'content-target';
    });
    vi.mocked(foregroundBrowserTarget).mockImplementationOnce(async () => {
      vi.setSystemTime(1_300);
    });
    const callBrowserTool = vi.fn(async () => ({ content: 'clicked' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-remaining-budget',
        action: 'click',
        payload: { target: 'button-ref' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 10_000,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserTarget).toHaveBeenCalledWith(9333, {
      deadlineAtMs: 11_000,
    });
    expect(foregroundBrowserTarget).toHaveBeenCalledWith(
      9333,
      'content-target',
      {
        deadlineAtMs: 11_000,
      },
    );
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 9_700,
      }),
    );
  });

  it('fails closed before backend dispatch when the browser IPC budget is exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    vi.mocked(ensureBrowserTarget).mockImplementationOnce(async () => {
      vi.setSystemTime(1_050);
      return 'content-target';
    });
    vi.mocked(foregroundBrowserTarget).mockImplementationOnce(async () => {
      vi.setSystemTime(1_101);
    });
    const callBrowserTool = vi.fn(async () => ({ content: 'clicked' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-exhausted-budget',
        action: 'click',
        payload: { target: 'button-ref' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 100,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Browser IPC deadline exceeded');
    expect(callBrowserTool).not.toHaveBeenCalled();
  });

  it('fails closed before backend dispatch when remaining budget is below backend minimum', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: true,
    });
    vi.mocked(ensureBrowserTarget).mockImplementationOnce(async () => {
      vi.setSystemTime(10_100);
      return 'content-target';
    });
    const callBrowserTool = vi.fn(async () => ({ content: 'clicked' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-below-backend-min',
        action: 'navigate',
        payload: { url: 'https://example.test' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        timeoutMs: 10_000,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'Browser IPC deadline exceeded before backend dispatch',
    );
    expect(callBrowserTool).not.toHaveBeenCalled();
  });

  it('keeps resize delegated to direct browser action backend', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: true,
    });
    vi.mocked(ensureBrowserTarget).mockResolvedValueOnce('content-target');
    const callBrowserTool = vi.fn(async () => ({ content: 'backend-resized' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-resize-headless',
        action: 'resize',
        payload: { width: 1280, height: 720 },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserTarget).toHaveBeenCalledWith(9333);
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'resize',
        arguments: { width: 1280, height: 720 },
      }),
    );
    expect(response.data).toEqual({
      content: [{ type: 'text', text: 'Browser window resized to 1280x720.' }],
    });
  });

  it('keeps oversized resize delegated to direct browser action backend', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: true,
    });
    vi.mocked(ensureBrowserTarget).mockResolvedValueOnce('content-target');
    const callBrowserTool = vi.fn(async () => ({ content: 'backend-resized' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-resize-headless-oversized',
        action: 'resize',
        payload: { width: 12_000, height: 20_000 },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserTarget).toHaveBeenCalledWith(9333);
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'resize',
        arguments: { width: 8192, height: 8192 },
      }),
    );
    expect(response.data).toEqual({
      content: [{ type: 'text', text: 'Browser window resized to 8192x8192.' }],
    });
  });

  it('denies non-status browser IPC when Browser is not authorized for the run', async () => {
    const callBrowserTool = vi.fn();
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1e',
        action: 'navigate',
        payload: { url: 'https://example.test' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Browser IPC is not authorized');
    expect(ensureBrowserReady).not.toHaveBeenCalled();
    expect(callBrowserTool).not.toHaveBeenCalled();
  });

  it('dispatches browser actions via explicit handlers', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2',
        action: 'open',
        payload: {
          profile_name: 'default',
        },
      },
      {
        sourceAgentFolder: 'main',
        browserIpcAuthorized: true,
        callBrowserTool: vi.fn(async () => ({ content: 'resized' })),
      },
    );

    expect(response.ok).toBe(true);
    expect(response.data).not.toHaveProperty('cdpUrl');
    expect(response.data).not.toHaveProperty('port');
    expect(response.data).not.toHaveProperty('pid');
    expect(response.data).not.toHaveProperty('targetId');
    expect(ensureBrowserReady).toHaveBeenCalledTimes(1);
    expect(ensureBrowserReady).toHaveBeenCalledWith({
      profileName: 'default',
      keepAliveMs: undefined,
      deadlineAtMs: undefined,
    });
  });

  it('rejects unsupported open payload fields', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-launch-headless',
        action: 'open',
        payload: {
          headless: true,
        },
      },
      {
        sourceAgentFolder: 'main',
        browserIpcAuthorized: true,
        callBrowserTool: vi.fn(async () => ({ content: 'resized' })),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      'open does not support payload field(s): headless',
    );
    expect(ensureBrowserReady).not.toHaveBeenCalled();
  });

  it('launches headed browser without backend viewport resize', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'stale-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async () => ({ content: 'resized' }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-launch-headed',
        action: 'open',
        payload: {},
      },
      {
        sourceAgentFolder: 'main',
        browserIpcAuthorized: true,
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserTarget).not.toHaveBeenCalled();
    expect(callBrowserTool).not.toHaveBeenCalled();
    expect(closeBrowser).not.toHaveBeenCalled();
    expect(ensureBrowserReady).toHaveBeenCalledTimes(1);
  });

  it('does not run launch-time resize recovery for backend failures', async () => {
    vi.mocked(ensureBrowserReady).mockResolvedValueOnce({
      profile: 'c-main-abc123abc123',
      profileName: 'c-main-abc123abc123',
      running: true,
      cdpReady: true,
      port: 9333,
      targetId: 'page-target',
      headless: false,
    });
    const callBrowserTool = vi.fn(async () => {
      throw new Error('stale backend target');
    });
    const closeBrowserToolBackends = vi.fn(async () => undefined);

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-launch-stale-backend',
        action: 'open',
        payload: {},
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
        closeBrowserToolBackends,
      },
    );

    expect(response.ok).toBe(true);
    expect(callBrowserTool).not.toHaveBeenCalled();
    expect(closeBrowserToolBackends).not.toHaveBeenCalled();
    expect(closeBrowser).not.toHaveBeenCalled();
    expect(ensureBrowserReady).toHaveBeenCalledTimes(1);
  });

  it('fails closed before launch when the signed deadline is already exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-launch-expired',
        action: 'open',
        payload: {},
      },
      {
        sourceAgentFolder: 'main',
        browserIpcAuthorized: true,
        deadlineAtMs: 1_999,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Browser IPC deadline exceeded');
    expect(ensureBrowserReady).not.toHaveBeenCalled();
  });

  it('passes signed browser IPC deadlines into launch work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-launch-deadline',
        action: 'open',
        payload: {},
      },
      {
        sourceAgentFolder: 'main',
        browserIpcAuthorized: true,
        timeoutMs: 2_000,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserReady).toHaveBeenCalledWith({
      profileName: 'default',
      keepAliveMs: undefined,
      deadlineAtMs: 3_000,
    });
  });

  it('includes tool-capability broker health on browser launch', async () => {
    const healthCheck = vi.fn(async () => ({
      status: 'fail' as const,
      message:
        'Could not reach OneCLI at http://localhost:10254: connect ECONNREFUSED',
      nextAction:
        "Run `myclaw local doctor`. If you use MyClaw's provided local stack, start it from the directory containing the shipped stack file, or pass that stack file explicitly, then retry.",
    }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2b',
        action: 'open',
        payload: {},
      },
      {
        sourceAgentFolder: 'main_agent',
        browserIpcAuthorized: true,
        getCredentialBrokerProfile: () => 'onecli',
        getCredentialBroker: async () => ({
          getInjection: vi.fn(),
          healthCheck,
          getCapabilities: () => ({
            profile: 'onecli',
            supportsAgentBinding: true,
            returnsRawSecrets: false,
          }),
        }),
      },
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      cdpReady: false,
      brokerHealthy: false,
      brokerHealth: {
        status: 'fail',
        message:
          'Could not reach OneCLI at http://localhost:10254: connect ECONNREFUSED',
      },
      warning: expect.stringContaining('CDP is not driveable'),
    });
    expect(healthCheck).toHaveBeenCalledWith({
      binding: {
        profile: 'onecli',
        purpose: 'tool_capability',
        agentIdentifier: 'agent:main_agent',
      },
    });
  });

  it('keeps browser status available when broker health check throws', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2c',
        action: 'status',
        payload: {},
      },
      {
        sourceAgentFolder: 'main_agent',
        getCredentialBrokerProfile: () => 'onecli',
        getCredentialBroker: async () => ({
          getInjection: vi.fn(),
          healthCheck: vi.fn(async () => {
            throw new Error('broker temporarily unavailable');
          }),
          getCapabilities: () => ({
            profile: 'onecli',
            supportsAgentBinding: true,
            returnsRawSecrets: false,
          }),
        }),
      },
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      running: true,
      cdpReady: false,
      brokerHealthy: false,
      brokerHealth: {
        status: 'fail',
        message: 'Credential broker health check failed.',
      },
      warning: expect.stringContaining('CDP is not driveable'),
    });
  });

  it('caches healthy broker status for repeated browser status calls', async () => {
    const healthCheck = vi.fn(async () => ({
      status: 'pass' as const,
      message: 'ok',
    }));
    const context = {
      sourceAgentFolder: 'cache_agent',
      getCredentialBrokerProfile: () => 'onecli',
      getCredentialBroker: async () => ({
        getInjection: vi.fn(),
        healthCheck,
        getCapabilities: () => ({
          profile: 'onecli',
          supportsAgentBinding: true,
          returnsRawSecrets: false,
        }),
      }),
    };

    for (const requestId of ['req-cache-1', 'req-cache-2']) {
      const response = await processBrowserIpcRequest(
        {
          requestId,
          action: 'status',
          payload: {},
        },
        context,
      );
      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({ brokerHealthy: true });
    }
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it('ignores main-agent profile overrides and uses host-derived profile', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2a',
        action: 'open',
        payload: {
          profile_name: 'other-profile',
        },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserReady).toHaveBeenCalledWith(
      expect.objectContaining({ profileName: 'c-main-abc123abc123' }),
    );
  });

  it('returns unsupported error for unknown browser action', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-3',
        action: 'browser_not_real' as BrowserBackendAction,
        payload: {},
      },
      { sourceAgentFolder: 'main' },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unsupported browser IPC action');
  });

  it('writes browser response files atomically', () => {
    const keys = createIpcResponseSigningKeyPair();
    writeBrowserIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'req-4',
        ok: true,
        data: { running: true },
      },
      keys.privateKeyPem,
    );

    const responsePath = path.join(
      tempDir,
      'grp',
      'browser-responses',
      'req-4.json',
    );
    const payload = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    expect(payload).toMatchObject({
      requestId: 'req-4',
      ok: true,
      data: { running: true },
    });
    expect(fileMode(path.dirname(responsePath))).toBe(0o700);
    expect(fileMode(responsePath)).toBe(0o600);
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

  it('does not write browser responses without a run response signing key', () => {
    writeBrowserIpcResponse(tempDir, 'grp', {
      requestId: 'req-5',
      ok: true,
      data: { running: true },
    });

    const responsePath = path.join(
      tempDir,
      'grp',
      'browser-responses',
      'req-5.json',
    );
    expect(fs.existsSync(responsePath)).toBe(false);
  });
});

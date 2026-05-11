import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activateBrowserTarget,
  ensureBrowserTarget,
  foregroundBrowserTarget,
  resizeHeadedBrowserWindow,
} from '@core/runtime/browser-cdp-targets.js';

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: vi.fn(async () => data),
    text: vi.fn(async () => 'ok'),
  };
}

function textResponse(data = 'ok') {
  return {
    ok: true,
    json: vi.fn(async () => ({})),
    text: vi.fn(async () => data),
  };
}

function stubCdpWebSocket(
  responses: Array<Record<string, unknown>>,
  opts: { respond?: boolean } = {},
) {
  const sent: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  let closeCalls = 0;
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string) {
      urls.push(url);
      queueMicrotask(() => this.onopen?.());
    }

    send(data: string) {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      sent.push(parsed);
      if (opts.respond === false) return;
      const response = responses.shift() || { id: parsed.id, result: {} };
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify(response) }),
      );
    }

    close() {
      closeCalls += 1;
      // Test websocket does not emit close for a caller-initiated close.
    }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return {
    get closeCalls() {
      return closeCalls;
    },
    sent,
    urls,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser CDP target cleanup', () => {
  it('closes internal omnibox tabs before and after activating content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'content', type: 'page', url: 'https://example.com' },
          { id: 'omnibox-1', type: 'page', url: 'chrome://omnibox-popup/' },
          { id: 'omnibox-2', type: 'page', url: 'chrome://omnibox-popup/2' },
          {
            id: 'omnibox-3',
            type: 'page',
            title: 'Omnibox Popup',
            url: 'about:blank',
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse())
      .mockResolvedValueOnce(textResponse())
      .mockResolvedValueOnce(textResponse())
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'content', type: 'page', url: 'https://example.com' },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'content', type: 'page', url: 'https://example.com' },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/root',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'content', type: 'page', url: 'https://example.com' },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const cdp = stubCdpWebSocket([{ id: 1, result: {} }]);

    await expect(ensureBrowserTarget(9222)).resolves.toBe('content');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9222/json/close/omnibox-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9222/json/close/omnibox-2',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9222/json/close/omnibox-3',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(cdp.urls).toEqual(['ws://127.0.0.1:9222/devtools/browser/root']);
    expect(cdp.sent).toEqual([
      {
        id: 1,
        method: 'Target.activateTarget',
        params: { targetId: 'content' },
      },
    ]);
  });

  it('activates a target through the browser CDP websocket', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/root',
        }),
      ),
    );
    const cdp = stubCdpWebSocket([{ id: 1, result: {} }]);

    await activateBrowserTarget(9222, 'target-1');

    expect(cdp.sent).toEqual([
      {
        id: 1,
        method: 'Target.activateTarget',
        params: { targetId: 'target-1' },
      },
    ]);
  });

  it('rejects browser websocket URLs outside the local CDP port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          webSocketDebuggerUrl: 'ws://example.com:9222/devtools/browser/root',
        }),
      ),
    );
    const cdp = stubCdpWebSocket([{ id: 1, result: {} }]);

    await expect(activateBrowserTarget(9222, 'target-1')).rejects.toThrow(
      'CDP websocket URL must stay on the local browser port',
    );

    expect(cdp.urls).toEqual([]);
  });

  it('foregrounds a target through activateTarget and page bringToFront', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/root',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'target-1',
            type: 'page',
            url: 'https://example.com',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-1',
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const cdp = stubCdpWebSocket([
      { id: 1, result: {} },
      { id: 1, result: {} },
    ]);

    await foregroundBrowserTarget(9222, 'target-1');

    expect(cdp.urls).toEqual([
      'ws://127.0.0.1:9222/devtools/browser/root',
      'ws://127.0.0.1:9222/devtools/page/target-1',
    ]);
    expect(cdp.sent).toEqual([
      {
        id: 1,
        method: 'Target.activateTarget',
        params: { targetId: 'target-1' },
      },
      {
        id: 1,
        method: 'Page.bringToFront',
        params: {},
      },
    ]);
  });

  it('rejects target websocket URLs outside the local CDP port', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/root',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'target-1',
            type: 'page',
            url: 'https://example.com',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/target-1',
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const cdp = stubCdpWebSocket([{ id: 1, result: {} }]);

    await expect(foregroundBrowserTarget(9222, 'target-1')).rejects.toThrow(
      'CDP websocket URL must stay on the local browser port',
    );

    expect(cdp.urls).toEqual(['ws://127.0.0.1:9222/devtools/browser/root']);
  });

  it('foregrounds a target through attach flow when target websocket is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/root',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'target-1',
            type: 'page',
            url: 'https://example.com',
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/root',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const cdp = stubCdpWebSocket([
      { id: 1, result: {} },
      { id: 1, result: { sessionId: 'session-1' } },
      { id: 2, result: {} },
      { id: 3, result: {} },
    ]);

    await foregroundBrowserTarget(9222, 'target-1');

    expect(cdp.urls).toEqual([
      'ws://127.0.0.1:9222/devtools/browser/root',
      'ws://127.0.0.1:9222/devtools/browser/root',
    ]);
    expect(cdp.sent).toEqual([
      {
        id: 1,
        method: 'Target.activateTarget',
        params: { targetId: 'target-1' },
      },
      {
        id: 1,
        method: 'Target.attachToTarget',
        params: { targetId: 'target-1', flatten: true },
      },
      {
        id: 2,
        method: 'Page.bringToFront',
        params: {},
        sessionId: 'session-1',
      },
      {
        id: 3,
        method: 'Target.detachFromTarget',
        params: { sessionId: 'session-1' },
      },
    ]);
  });

  it('times out browser CDP commands with the provided timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/root',
        }),
      ),
    );
    const cdp = stubCdpWebSocket([], { respond: false });

    const activation = activateBrowserTarget(9222, 'target-1', {
      timeoutMs: 25,
    });
    const expectation = expect(activation).rejects.toThrow(
      'CDP command Target.activateTarget timed out',
    );
    await vi.waitFor(() => expect(cdp.sent).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(24);
    await vi.advanceTimersByTimeAsync(1);

    await expectation;
    expect(cdp.closeCalls).toBe(1);
  });

  it('aborts slow CDP HTTP requests with the provided timeout', async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string | URL | Request, init?: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      ),
    );

    const target = ensureBrowserTarget(9222, { timeoutMs: 25 });
    const expectation = expect(target).rejects.toThrow(
      'CDP HTTP GET /json/list timed out',
    );
    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    expect(aborted).toBe(true);
  });

  it('fails closed before CDP work when the absolute deadline is exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      foregroundBrowserTarget(9222, 'target-1', { deadlineAtMs: 999 }),
    ).rejects.toThrow('Browser CDP deadline exceeded');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resizes a headed browser window through CDP window bounds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/root',
        }),
      ),
    );
    const cdp = stubCdpWebSocket([
      { id: 1, result: { windowId: 42 } },
      { id: 1, result: {} },
    ]);

    await resizeHeadedBrowserWindow(9222, 'target-1', 1200, 800);

    expect(cdp.sent).toEqual([
      {
        id: 1,
        method: 'Browser.getWindowForTarget',
        params: { targetId: 'target-1' },
      },
      {
        id: 1,
        method: 'Browser.setWindowBounds',
        params: {
          windowId: 42,
          bounds: { windowState: 'normal', width: 1200, height: 800 },
        },
      },
    ]);
  });
});

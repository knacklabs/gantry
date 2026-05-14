import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
  browsers: [] as any[],
  connectOverCDP: vi.fn(),
}));

vi.mock('playwright-core', () => ({
  chromium: {
    connectOverCDP: browserMocks.connectOverCDP,
  },
}));

import {
  callBrowserTool,
  closeBrowserToolBackends,
  formatBackendError,
  sanitizeBrowserTabsResult,
} from '@core/adapters/browser/browser-direct-driver.js';
import { normalizeBrowserToolResult } from '@core/adapters/browser/browser-result-hygiene.js';
import { snapshotPage } from '@core/adapters/browser/browser-direct-page-actions.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-browser-direct-'));
  tempRoots.push(root);
  return root;
}

function createPage(opts: {
  url?: string;
  title?: string;
  redirectUrl?: string;
  screenshotBuffers?: Buffer[];
  locatorClick?: ReturnType<typeof vi.fn>;
}) {
  const locator = {
    click: opts.locatorClick ?? vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    dragTo: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    uncheck: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    screenshot: vi.fn(async (args?: { type?: string }) => {
      const next = opts.screenshotBuffers?.shift();
      if (next) return next;
      return Buffer.from(
        args?.type === 'jpeg' ? 'locator jpeg' : 'locator png',
      );
    }),
    innerText: vi.fn(async () => 'target text'),
    evaluate: vi.fn(async () => 'target-value'),
    count: vi.fn(async () => 1),
    first: vi.fn(() => locator),
  };
  const page = {
    _url: opts.url ?? 'https://93.184.216.34/',
    on: vi.fn(),
    once: vi.fn(),
    url: vi.fn(() => page._url),
    title: vi.fn(async () => opts.title ?? 'Example'),
    bringToFront: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    goto: vi.fn(async (url: string) => {
      if (opts.redirectUrl) {
        page._url = opts.redirectUrl;
        return { status: () => 302 };
      }
      page._url = url;
      return { status: () => 200 };
    }),
    goBack: vi.fn(async () => undefined),
    locator: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    keyboard: {
      type: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
    },
    waitForTimeout: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    setViewportSize: vi.fn(async () => undefined),
    viewportSize: vi.fn(() => ({ width: 1280, height: 900 })),
    screenshot: vi.fn(async (args?: { type?: string }) => {
      const next = opts.screenshotBuffers?.shift();
      if (next) return next;
      return Buffer.from(args?.type === 'jpeg' ? 'jpeg' : 'png');
    }),
    evaluate: vi.fn(async () => ({
      title: opts.title ?? 'Example',
      url: page._url,
      bodyText: 'Example body',
      elements: [{ ref: 'e1', role: 'button', tag: 'button', label: 'Go' }],
    })),
  };
  return { page, locator };
}

function createBrowser(pages: any[]) {
  const context = {
    pages: vi.fn(() => pages),
    newPage: vi.fn(async () => {
      const { page } = createPage({ url: 'about:blank', title: '' });
      pages.push(page);
      return page;
    }),
    on: vi.fn(),
  };
  const browser = {
    contexts: vi.fn(() => [context]),
    close: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { browser, context };
}

function createDomElement(input: {
  tagName: string;
  text?: string;
  value?: string;
  rect?: { width: number; height: number };
  attributes?: Record<string, string>;
}) {
  const attributes = new Map(Object.entries(input.attributes ?? {}));
  return {
    tagName: input.tagName,
    innerText: input.text ?? '',
    value: input.value ?? '',
    getBoundingClientRect: vi.fn(() => input.rect ?? { width: 10, height: 10 }),
    getAttribute: vi.fn((name: string) => attributes.get(name) ?? null),
    setAttribute: vi.fn((name: string, value: string) => {
      attributes.set(name, value);
    }),
    removeAttribute: vi.fn((name: string) => {
      attributes.delete(name);
    }),
    attributeValue(name: string) {
      return attributes.get(name);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function pngWithDimensions(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer[0] = 0x89;
  buffer.write('PNG', 1, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function session(port = 12345) {
  return {
    running: true,
    cdpReady: true,
    port,
    profileName: 'c-main',
  };
}

afterEach(async () => {
  await closeBrowserToolBackends();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  browserMocks.browsers.splice(0);
  browserMocks.connectOverCDP.mockReset();
  vi.useRealTimers();
});

describe('browser direct driver', () => {
  it('reuses one Playwright CDP connection across browser actions', async () => {
    const root = tempRoot();
    const { page } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'navigate',
      arguments: { url: 'https://93.184.216.34/one' },
      session: session(),
      fileAccessRoot: root,
      timeoutMs: 2_000,
    });
    await callBrowserTool({
      toolName: 'snapshot',
      arguments: {},
      session: session(),
      fileAccessRoot: root,
      timeoutMs: 120_001,
    });

    expect(browserMocks.connectOverCDP).toHaveBeenCalledTimes(1);
    expect(browserMocks.connectOverCDP).toHaveBeenCalledWith(
      'http://127.0.0.1:12345',
      { timeout: 10_000 },
    );
  });

  it('clears stale element refs before assigning refs for a new snapshot', async () => {
    const oldHidden = createDomElement({
      tagName: 'BUTTON',
      text: 'Old hidden button',
      rect: { width: 0, height: 0 },
      attributes: { 'data-myclaw-ref': 'e1' },
    });
    const newVisible = createDomElement({
      tagName: 'BUTTON',
      text: 'New visible button',
    });
    const originalDocument = (globalThis as any).document;
    const originalLocation = (globalThis as any).location;
    const page = {
      evaluate: vi.fn(async (callback: () => unknown) => {
        (globalThis as any).document = {
          title: 'Changed controls',
          body: { innerText: 'New visible button' },
          querySelectorAll: vi.fn((selector: string) =>
            selector === '[data-myclaw-ref]'
              ? [oldHidden]
              : [oldHidden, newVisible],
          ),
        };
        (globalThis as any).location = {
          href: 'https://example.test/changed',
        };
        try {
          return callback();
        } finally {
          (globalThis as any).document = originalDocument;
          (globalThis as any).location = originalLocation;
        }
      }),
    };

    const output = await snapshotPage(page as never, {});

    expect(oldHidden.removeAttribute).toHaveBeenCalledWith('data-myclaw-ref');
    expect(oldHidden.attributeValue('data-myclaw-ref')).toBeUndefined();
    expect(newVisible.setAttribute).toHaveBeenCalledWith(
      'data-myclaw-ref',
      'e1',
    );
    expect(output).toContain('- e1: button "New visible button"');
  });

  it('keeps a pending CDP connection shared after one caller times out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const root = tempRoot();
    const pending = deferred<any>();
    const { page } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockReturnValue(pending.promise);

    const shortWaiter = callBrowserTool({
      toolName: 'snapshot',
      arguments: {},
      session: session(),
      fileAccessRoot: root,
      timeoutMs: 1_000,
    });
    const shortWaiterResult = shortWaiter.catch((err) => err);
    const longWaiter = callBrowserTool({
      toolName: 'snapshot',
      arguments: {},
      session: session(),
      fileAccessRoot: root,
      timeoutMs: 5_000,
    });

    await Promise.resolve();
    expect(browserMocks.connectOverCDP).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(await shortWaiterResult).toMatchObject({
      message: 'Browser connection startup timed out.',
    });

    pending.resolve(browser);
    await expect(longWaiter).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(browserMocks.connectOverCDP).toHaveBeenCalledTimes(1);
  });

  it('only closes cached and pending direct connections for the requested profile', async () => {
    const root = tempRoot();
    const { page: mainPage } = createPage({ url: 'https://93.184.216.34/' });
    const { page: otherPage } = createPage({ url: 'https://93.184.216.35/' });
    const main = createBrowser([mainPage]);
    const other = createBrowser([otherPage]);
    browserMocks.connectOverCDP
      .mockResolvedValueOnce(main.browser)
      .mockResolvedValueOnce(other.browser);

    await callBrowserTool({
      toolName: 'snapshot',
      arguments: {},
      session: session(12345),
      fileAccessRoot: root,
    });
    await callBrowserTool({
      toolName: 'snapshot',
      arguments: {},
      session: { ...session(23456), profileName: 'c-other' },
      fileAccessRoot: root,
    });

    await closeBrowserToolBackends('c-main');

    expect(main.browser.close).toHaveBeenCalledTimes(1);
    expect(other.browser.close).not.toHaveBeenCalled();

    await callBrowserTool({
      toolName: 'snapshot',
      arguments: {},
      session: { ...session(23456), profileName: 'c-other' },
      fileAccessRoot: root,
    });
    expect(browserMocks.connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it('materializes inline upload files under the artifact root before setInputFiles', async () => {
    const root = tempRoot();
    const { page } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'file_upload',
      arguments: {
        files: [
          { name: 'note.txt', content: 'hello' },
          {
            name: 'encoded.bin',
            content: Buffer.from('bytes').toString('base64'),
            encoding: 'base64',
          },
        ],
      },
      session: session(),
      fileAccessRoot: root,
    });

    const paths = page.setInputFiles.mock.calls[0]?.[1] as string[];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain(`${path.sep}uploads${path.sep}inline-`);
    expect(paths[1]).toContain(`${path.sep}uploads${path.sep}inline-`);
    expect(fs.readFileSync(paths[0]!, 'utf8')).toBe('hello');
    expect(fs.readFileSync(paths[1]!, 'utf8')).toBe('bytes');
  });

  it('rejects raw upload paths and output paths outside the artifact root', async () => {
    const root = tempRoot();
    const { page } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await expect(
      callBrowserTool({
        toolName: 'file_upload',
        arguments: { paths: ['/tmp/outside.txt'] },
        session: session(),
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('filesystem paths are not accepted');

    await expect(
      callBrowserTool({
        toolName: 'snapshot',
        arguments: { filename: '../outside.txt' },
        session: session(),
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('limited to the run browser artifact root');
  });

  it('does not materialize inline uploads before CDP is connected', async () => {
    const root = tempRoot();
    browserMocks.connectOverCDP.mockRejectedValue(new Error('CDP down'));

    await expect(
      callBrowserTool({
        toolName: 'file_upload',
        arguments: { files: [{ name: 'note.txt', content: 'hello' }] },
        session: session(),
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('CDP down');

    expect(fs.existsSync(path.join(root, 'uploads'))).toBe(false);
  });

  it('writes screenshots to files and falls back to jpeg when size exceeds the limit', async () => {
    const root = tempRoot();
    const large = Buffer.alloc(6 * 1024 * 1024, 1);
    const smallJpeg = Buffer.from('jpeg bytes');
    const { page } = createPage({
      url: 'https://93.184.216.34/',
      screenshotBuffers: [large, smallJpeg],
    });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    const result = await callBrowserTool({
      toolName: 'screenshot',
      arguments: { filename: 'shot.png' },
      session: session(),
      fileAccessRoot: root,
    });

    const output = fs.realpathSync.native(path.join(root, 'shot.png'));
    expect(page.screenshot).toHaveBeenNthCalledWith(2, {
      type: 'jpeg',
      quality: 85,
      fullPage: false,
    });
    expect(fs.readFileSync(output, 'utf8')).toBe('jpeg bytes');
    expect(JSON.stringify(result)).not.toContain(smallJpeg.toString('base64'));
    expect(result).toMatchObject({
      file: {
        path: output,
        mimeType: 'image/jpeg',
        sizeBytes: smallJpeg.byteLength,
      },
    });
  });

  it('allows oversized full-page screenshots without mutating the viewport', async () => {
    const root = tempRoot();
    const oversized = pngWithDimensions(4_000, 1_000);
    const { page } = createPage({
      url: 'https://93.184.216.34/',
      screenshotBuffers: [oversized],
    });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'screenshot',
      arguments: { filename: 'full.png', fullPage: true },
      session: session(),
      fileAccessRoot: root,
    });

    expect(page.setViewportSize).not.toHaveBeenCalled();
    expect(page.screenshot).toHaveBeenNthCalledWith(1, {
      type: 'png',
      fullPage: true,
    });
  });

  it('restores the viewport after normalizing oversized viewport screenshots', async () => {
    const root = tempRoot();
    const oversized = pngWithDimensions(4_000, 1_000);
    const normalized = pngWithDimensions(2_000, 450);
    const { page } = createPage({
      url: 'https://93.184.216.34/',
      screenshotBuffers: [oversized, normalized],
    });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'screenshot',
      arguments: { filename: 'viewport.png' },
      session: session(),
      fileAccessRoot: root,
    });

    expect(page.setViewportSize).toHaveBeenNthCalledWith(1, {
      width: 640,
      height: 450,
    });
    expect(page.setViewportSize).toHaveBeenNthCalledWith(2, {
      width: 1280,
      height: 900,
    });
    expect(page.screenshot).toHaveBeenNthCalledWith(2, {
      type: 'png',
      fullPage: false,
    });
  });

  it('uses locator screenshots when a target is provided', async () => {
    const root = tempRoot();
    const { page, locator } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'screenshot',
      arguments: { target: 'e1', filename: 'element.png' },
      session: session(),
      fileAccessRoot: root,
    });

    expect(locator.screenshot).toHaveBeenCalledWith({ type: 'png' });
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it('keeps resized screenshot compression inside the bounded viewport before restoring', async () => {
    const root = tempRoot();
    const oversized = pngWithDimensions(4_000, 1_000);
    const resizedStillLarge = Buffer.concat([
      pngWithDimensions(2_000, 450),
      Buffer.alloc(6 * 1024 * 1024, 1),
    ]);
    const compressed = Buffer.from('small jpeg');
    const { page } = createPage({
      url: 'https://93.184.216.34/',
      screenshotBuffers: [oversized, resizedStillLarge, compressed],
    });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'screenshot',
      arguments: { filename: 'compressed.png' },
      session: session(),
      fileAccessRoot: root,
    });

    expect(page.screenshot).toHaveBeenNthCalledWith(3, {
      type: 'jpeg',
      quality: 85,
      fullPage: false,
    });
    expect(page.setViewportSize).toHaveBeenNthCalledWith(2, {
      width: 1280,
      height: 900,
    });
  });

  it('allows hostname navigation without an adapter URL gate', async () => {
    const root = tempRoot();
    const { page } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await expect(
      callBrowserTool({
        toolName: 'navigate',
        arguments: { url: 'https://example.com/' },
        session: session(),
        fileAccessRoot: root,
      }),
    ).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(page.goto).toHaveBeenCalledWith('https://example.com/', {
      waitUntil: 'domcontentloaded',
      timeout: expect.any(Number),
    });
  });

  it('lets Playwright handle redirects without adapter URL gating', async () => {
    const root = tempRoot();
    const { page } = createPage({
      url: 'https://93.184.216.34/',
      redirectUrl: 'https://example.com/',
    });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await expect(
      callBrowserTool({
        toolName: 'navigate',
        arguments: { url: 'https://93.184.216.34/' },
        session: session(),
        fileAccessRoot: root,
      }),
    ).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(page.url()).toBe('https://example.com/');
  });

  it('uses commit-only waiting for back navigation', async () => {
    const root = tempRoot();
    const { page } = createPage({ url: 'https://example.com/previous' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'back',
      arguments: {},
      session: session(),
      fileAccessRoot: root,
    });

    expect(page.goBack).toHaveBeenCalledWith({
      waitUntil: 'commit',
      timeout: expect.any(Number),
    });
  });

  it('passes requested action deadlines to Playwright operations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const root = tempRoot();
    const { page, locator } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'click',
      arguments: { target: 'e1' },
      session: session(),
      fileAccessRoot: root,
      timeoutMs: 90_000,
    });

    expect(locator.click).toHaveBeenCalledWith({
      button: 'left',
      clickCount: 1,
      timeout: 90_000,
    });
  });

  it('resizes through the selected Playwright page viewport', async () => {
    const root = tempRoot();
    const { page } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'resize',
      arguments: { width: 1024, height: 768 },
      session: session(),
      fileAccessRoot: root,
    });

    expect(page.setViewportSize).toHaveBeenCalledWith({
      width: 1024,
      height: 768,
    });
  });

  it('hides internal tabs and fails closed when visible tab mapping is stale', async () => {
    const root = tempRoot();
    const { page: visible } = createPage({
      url: 'https://93.184.216.34/',
      title: 'Example',
    });
    const { page: internal } = createPage({
      url: 'chrome://new-tab-page/',
      title: 'New tab',
    });
    const { page: other } = createPage({
      url: 'https://other.test/',
      title: 'Other',
    });
    const { browser } = createBrowser([visible, internal, other]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    const result = await callBrowserTool({
      toolName: 'tabs',
      arguments: { action: 'list' },
      session: session(),
      fileAccessRoot: root,
    });

    expect(JSON.stringify(result)).not.toContain('chrome://new-tab-page');
    expect(result).toMatchObject({
      structuredContent: {
        tabs: [
          { index: 0, url: 'https://93.184.216.34/' },
          { index: 1, url: 'https://other.test/' },
        ],
      },
    });
    await callBrowserTool({
      toolName: 'tabs',
      arguments: { action: 'select', index: 1 },
      session: session(),
      fileAccessRoot: root,
    });
    expect(other.bringToFront).toHaveBeenCalled();

    await closeBrowserToolBackends('c-main');
    await expect(
      callBrowserTool({
        toolName: 'tabs',
        arguments: { action: 'select', index: 0 },
        session: session(),
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('needs a fresh tabs list');
  });

  it('reconnects once on stale page/context/browser errors', async () => {
    const root = tempRoot();
    const staleClick = vi.fn(async () => {
      throw new Error('Target page, context or browser has been closed');
    });
    const { page: stalePage } = createPage({
      url: 'https://93.184.216.34/',
      locatorClick: staleClick,
    });
    const { page: freshPage, locator: freshLocator } = createPage({
      url: 'https://93.184.216.34/',
    });
    const first = createBrowser([stalePage]);
    const second = createBrowser([freshPage]);
    browserMocks.connectOverCDP
      .mockResolvedValueOnce(first.browser)
      .mockResolvedValueOnce(second.browser);

    const result = await callBrowserTool({
      toolName: 'click',
      arguments: { target: 'e1' },
      session: session(),
      fileAccessRoot: root,
    });

    expect(first.browser.close).toHaveBeenCalled();
    expect(browserMocks.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(freshLocator.click).toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Clicked element.' }],
    });
  });

  it('passes click modifiers and dispatches data drops without filesystem paths', async () => {
    const root = tempRoot();
    const { page, locator } = createPage({ url: 'https://93.184.216.34/' });
    const { browser } = createBrowser([page]);
    browserMocks.connectOverCDP.mockResolvedValue(browser);

    await callBrowserTool({
      toolName: 'click',
      arguments: { target: 'e1', modifiers: ['Shift', 'Meta', 'Bad'] },
      session: session(),
      fileAccessRoot: root,
    });
    await callBrowserTool({
      toolName: 'drop',
      arguments: { target: 'e1', data: { 'text/plain': 'hello' } },
      session: session(),
      fileAccessRoot: root,
    });

    expect(locator.click).toHaveBeenCalledWith({
      button: 'left',
      clickCount: 1,
      modifiers: ['Shift', 'Meta'],
      timeout: expect.any(Number),
    });
    expect(locator.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      'text/plain': 'hello',
    });
    await expect(
      callBrowserTool({
        toolName: 'drop',
        arguments: { target: 'e1', paths: ['old-secret.txt'] },
        session: session(),
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('filesystem paths are not accepted');
  });

  it('formats timeout failures distinctly from other backend failures', () => {
    expect(
      formatBackendError('tabs', new Error('Timed out waiting for tab list')),
    ).toContain('Browser backend timeout');
  });

  it('sanitizes tab result helpers without raw internal targets', () => {
    const result = sanitizeBrowserTabsResult({
      content: [
        {
          type: 'text',
          text: [
            '- 0: Example https://93.184.216.34/',
            '- 1: New tab chrome://new-tab-page/',
          ].join('\n'),
        },
      ],
      structuredContent: {
        tabs: [
          { index: 0, title: 'Example', url: 'https://93.184.216.34/' },
          { index: 1, title: 'New tab', url: 'chrome://new-tab-page/' },
        ],
      },
    });

    expect(JSON.stringify(result)).not.toContain('chrome://new-tab-page');
    expect(result).toMatchObject({
      structuredContent: {
        tabs: [{ index: 0, title: 'Example', url: 'https://93.184.216.34/' }],
      },
    });
  });

  it('sanitizes invalid unicode from browser tool output before SDK delivery', () => {
    const result = normalizeBrowserToolResult(
      'snapshot',
      {},
      {
        content: [
          {
            type: 'text',
            text: 'valid \uD83D\uDE00 lone-high \uD83D lone-low \uDE00',
          },
        ],
      },
    ) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toBe('valid 😀 lone-high � lone-low �');
    expect(JSON.stringify(result)).not.toContain('\\ud83d');
    expect(JSON.stringify(result)).not.toContain('\\ude00');
  });
});

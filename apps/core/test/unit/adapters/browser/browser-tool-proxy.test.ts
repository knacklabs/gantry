import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const browserMcpMocks = vi.hoisted(() => ({
  clients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  transports: [] as Array<{
    options: Record<string, unknown>;
    close: ReturnType<typeof vi.fn>;
  }>,
  nextResult: undefined as unknown,
  callToolImpl: undefined as
    | ((request: unknown, extra: unknown, options: unknown) => Promise<unknown>)
    | undefined,
  connectImpl: undefined as
    | ((transport: unknown, options: unknown) => Promise<unknown>)
    | undefined,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function Client() {
    const client = {
      connect: vi.fn(async () => undefined),
      callTool: vi.fn(
        async (request: unknown, extra: unknown, options: unknown) =>
          browserMcpMocks.callToolImpl
            ? browserMcpMocks.callToolImpl(request, extra, options)
            : (browserMcpMocks.nextResult ?? { content: [] }),
      ),
      close: vi.fn(async () => undefined),
    };
    if (browserMcpMocks.connectImpl) {
      client.connect.mockImplementation(browserMcpMocks.connectImpl);
    }
    browserMcpMocks.clients.push(client);
    return client;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(function StdioClientTransport(
    options: Record<string, unknown>,
  ) {
    const transport = {
      options,
      close: vi.fn(async () => undefined),
    };
    browserMcpMocks.transports.push(transport);
    return transport;
  }),
}));

vi.mock('@core/runtime/browser-cdp-targets.js', () => ({
  ensureBrowserTarget: vi.fn(async () => 'target-1'),
}));

import {
  callBrowserTool,
  closeBrowserToolBackends,
  formatBackendError,
  normalizeBrowserToolResult,
  sanitizeBrowserTabsResult,
} from '@core/adapters/browser/browser-tool-proxy.js';
import {
  BROWSER_ACTION_TIMEOUT_MS,
  createBrowserActionMcpServerConfig,
} from '@core/adapters/browser/action-mcp.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-browser-proxy-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await closeBrowserToolBackends();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  browserMcpMocks.clients.splice(0);
  browserMcpMocks.transports.splice(0);
  browserMcpMocks.nextResult = undefined;
  browserMcpMocks.callToolImpl = undefined;
  browserMcpMocks.connectImpl = undefined;
  vi.useRealTimers();
});

describe('browser tool proxy file policy', () => {
  it('starts the private backend with a longer action timeout', () => {
    const config = createBrowserActionMcpServerConfig(
      'http://127.0.0.1:12345',
      { actionTimeoutMs: 45_000 },
    );

    expect(config.args).toEqual(
      expect.arrayContaining(['--timeout-action', String(45_000)]),
    );
  });

  it('uses a stable backend action timeout while clamping each tool call', async () => {
    const root = tempRoot();
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/' },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
      timeoutMs: 999,
    });

    expect(browserMcpMocks.transports[0]?.options.args).toEqual(
      expect.arrayContaining(['--timeout-action', '120000']),
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenLastCalledWith(
      {
        name: 'browser_navigate',
        arguments: { url: 'https://example.test/' },
      },
      undefined,
      { timeout: expect.any(Number) },
    );
    const timeout = browserMcpMocks.clients[0]?.callTool.mock.lastCall?.[2]
      ?.timeout as number;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(1_000);
  });

  it('defaults non-finite action timeouts before backend startup and tool calls', async () => {
    const root = tempRoot();
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/' },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
      timeoutMs: Number.NaN,
    });

    expect(browserMcpMocks.transports[0]?.options.args).toEqual(
      expect.arrayContaining(['--timeout-action', '120000']),
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenLastCalledWith(
      {
        name: 'browser_navigate',
        arguments: { url: 'https://example.test/' },
      },
      undefined,
      { timeout: expect.any(Number) },
    );
    const timeout = browserMcpMocks.clients[0]?.callTool.mock.lastCall?.[2]
      ?.timeout as number;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(BROWSER_ACTION_TIMEOUT_MS);
  });

  it('reuses one backend across varied action timeouts', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/one' },
      session,
      fileAccessRoot: root,
      timeoutMs: 2_000,
    });
    await callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/two' },
      session,
      fileAccessRoot: root,
      timeoutMs: 2_000,
    });
    await callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/three' },
      session,
      fileAccessRoot: root,
      timeoutMs: 120_001,
    });
    await callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/four' },
      session,
      fileAccessRoot: root,
      timeoutMs: 999,
    });
    await callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/five' },
      session,
      fileAccessRoot: root,
      timeoutMs: 1_000,
    });

    expect(browserMcpMocks.transports).toHaveLength(1);
    expect(browserMcpMocks.transports[0]?.options.args).toEqual(
      expect.arrayContaining(['--timeout-action', '120000']),
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenCalledTimes(5);
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      1,
      {
        name: 'browser_navigate',
        arguments: { url: 'https://example.test/one' },
      },
      undefined,
      { timeout: expect.any(Number) },
    );
    const firstTimeout = browserMcpMocks.clients[0]?.callTool.mock.calls[0]?.[2]
      ?.timeout as number;
    expect(firstTimeout).toBeGreaterThan(0);
    expect(firstTimeout).toBeLessThanOrEqual(2_000);
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      3,
      {
        name: 'browser_navigate',
        arguments: { url: 'https://example.test/three' },
      },
      undefined,
      { timeout: expect.any(Number) },
    );
    const maxTimeout = browserMcpMocks.clients[0]?.callTool.mock.calls[2]?.[2]
      ?.timeout as number;
    expect(maxTimeout).toBeGreaterThan(0);
    expect(maxTimeout).toBeLessThanOrEqual(120_000);
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      4,
      {
        name: 'browser_navigate',
        arguments: { url: 'https://example.test/four' },
      },
      undefined,
      { timeout: expect.any(Number) },
    );
    const minTimeout = browserMcpMocks.clients[0]?.callTool.mock.calls[3]?.[2]
      ?.timeout as number;
    expect(minTimeout).toBeGreaterThan(0);
    expect(minTimeout).toBeLessThanOrEqual(1_000);
  });

  it('subtracts backend startup time from the tool call timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const root = tempRoot();
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };
    browserMcpMocks.connectImpl = vi.fn(async () => {
      vi.setSystemTime(1_750);
      return undefined;
    });

    await callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/' },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
      timeoutMs: 2_000,
    });

    expect(browserMcpMocks.clients[0]?.connect).toHaveBeenCalledWith(
      expect.anything(),
      { timeout: 60_000 },
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenLastCalledWith(
      {
        name: 'browser_navigate',
        arguments: { url: 'https://example.test/' },
      },
      undefined,
      { timeout: 1_250 },
    );
  });

  it('fails backend startup on the request deadline before tool dispatch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const root = tempRoot();
    let resolveConnect: (() => void) | undefined;
    browserMcpMocks.connectImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConnect = () => resolve(undefined);
        }),
    );

    const call = callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/' },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
      timeoutMs: 1_000,
    });

    const rejection = expect(call).rejects.toThrow(
      'Browser backend startup timed out',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    expect(browserMcpMocks.clients[0]?.connect).toHaveBeenCalledWith(
      expect.anything(),
      { timeout: 60_000 },
    );
    expect(browserMcpMocks.clients[0]?.callTool).not.toHaveBeenCalled();

    resolveConnect?.();
    await vi.runOnlyPendingTimersAsync();
  });

  it('does not let a short startup waiter poison a longer pending backend waiter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const root = tempRoot();
    let resolveConnect: (() => void) | undefined;
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };
    browserMcpMocks.connectImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConnect = () => resolve(undefined);
        }),
    );
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    const shortCall = callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/short' },
      session,
      fileAccessRoot: root,
      timeoutMs: 1_000,
    });
    const longCall = callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/long' },
      session,
      fileAccessRoot: root,
      timeoutMs: 5_000,
    });

    const shortRejection = expect(shortCall).rejects.toThrow(
      'Browser backend startup timed out',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await shortRejection;

    expect(browserMcpMocks.clients).toHaveLength(1);
    expect(browserMcpMocks.clients[0]?.callTool).not.toHaveBeenCalled();

    vi.setSystemTime(2_500);
    resolveConnect?.();
    await Promise.resolve();
    await expect(longCall).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });

    expect(browserMcpMocks.clients).toHaveLength(1);
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenCalledWith(
      {
        name: 'browser_navigate',
        arguments: { url: 'https://example.test/long' },
      },
      undefined,
      { timeout: 3_500 },
    );
    expect(browserMcpMocks.clients[0]?.close).not.toHaveBeenCalled();
  });

  it('schedules idle cleanup for a backend that resolves after all startup waiters time out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const root = tempRoot();
    let resolveConnect: (() => void) | undefined;
    browserMcpMocks.connectImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConnect = () => resolve(undefined);
        }),
    );

    const call = callBrowserTool({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.test/' },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
      timeoutMs: 1_000,
    });

    const rejection = expect(call).rejects.toThrow(
      'Browser backend startup timed out',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    resolveConnect?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(browserMcpMocks.clients[0]?.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(browserMcpMocks.clients[0]?.close).toHaveBeenCalledTimes(1);
    expect(browserMcpMocks.transports[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('sanitizes filename on snapshot, console, and evaluate before backend dispatch', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    for (const toolName of [
      'browser_snapshot',
      'browser_console_messages',
      'browser_evaluate',
    ] as const) {
      await expect(
        callBrowserTool({
          toolName,
          arguments: {
            filename: '/tmp/outside-browser-facade.txt',
          },
          session,
          fileAccessRoot: root,
        }),
      ).rejects.toThrow('limited to the run browser artifact root');
    }
  });

  it('rejects hidden and sensitive browser output path segments', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    for (const filename of [
      '.hidden/out.txt',
      'settings.yaml',
      'credentials/out.txt',
      'browser-profiles/profile.txt',
    ]) {
      await expect(
        callBrowserTool({
          toolName: 'browser_snapshot',
          arguments: { filename },
          session,
          fileAccessRoot: root,
        }),
      ).rejects.toThrow('hidden or sensitive paths');
    }
  });

  it('rejects upload symlinks under the extra workspace', async () => {
    const root = tempRoot();
    const target = path.join(tempRoot(), 'secret.txt');
    fs.writeFileSync(target, 'secret');
    fs.symlinkSync(target, path.join(root, 'linked.txt'));

    await expect(
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: { paths: ['linked.txt'] },
        session: {
          running: true,
          cdpReady: true,
          port: 12345,
          profileName: 'c-main',
        },
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('regular files');
  });

  it('materializes inline upload files under the browser artifact root', async () => {
    const root = tempRoot();
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_file_upload',
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
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
    });

    const paths = browserMcpMocks.clients[0]?.callTool.mock.calls[0]?.[0]
      ?.arguments?.paths as string[];
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(paths[0]).toContain(`${path.sep}uploads${path.sep}inline-`);
    expect(paths[1]).toContain(`${path.sep}uploads${path.sep}inline-`);
    expect(fs.readFileSync(paths[0]!, 'utf8')).toBe('hello');
    expect(fs.readFileSync(paths[1]!, 'utf8')).toBe('bytes');
  });

  it('combines existing upload paths with inline upload files', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'existing.txt'), 'existing');
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_file_upload',
      arguments: {
        paths: ['existing.txt'],
        files: [{ name: 'note.txt', content: 'hello' }],
      },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
    });

    const paths = browserMcpMocks.clients[0]?.callTool.mock.calls[0]?.[0]
      ?.arguments?.paths as string[];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(
      fs.realpathSync.native(path.join(root, 'existing.txt')),
    );
    expect(paths[1]).toContain(`${path.sep}uploads${path.sep}inline-`);
    expect(fs.readFileSync(paths[1]!, 'utf8')).toBe('hello');
  });

  it('does not overwrite an existing uploads file with the same inline filename', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(root, 'uploads/note.txt'), 'existing');
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_file_upload',
      arguments: {
        files: [{ name: 'note.txt', content: 'inline' }],
      },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
    });

    const paths = browserMcpMocks.clients[0]?.callTool.mock.calls[0]?.[0]
      ?.arguments?.paths as string[];
    expect(paths).toHaveLength(1);
    expect(paths[0]).not.toBe(
      fs.realpathSync.native(path.join(root, 'uploads/note.txt')),
    );
    expect(fs.readFileSync(path.join(root, 'uploads/note.txt'), 'utf8')).toBe(
      'existing',
    );
    expect(fs.readFileSync(paths[0]!, 'utf8')).toBe('inline');
  });

  it('keeps existing upload paths distinct from inline files with the same basename', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(root, 'uploads/note.txt'), 'existing');
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_file_upload',
      arguments: {
        paths: ['uploads/note.txt'],
        files: [{ name: 'note.txt', content: 'inline' }],
      },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
    });

    const paths = browserMcpMocks.clients[0]?.callTool.mock.calls[0]?.[0]
      ?.arguments?.paths as string[];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(
      fs.realpathSync.native(path.join(root, 'uploads/note.txt')),
    );
    expect(paths[1]).not.toBe(paths[0]);
    expect(fs.readFileSync(paths[0]!, 'utf8')).toBe('existing');
    expect(fs.readFileSync(paths[1]!, 'utf8')).toBe('inline');
  });

  it('uses distinct inline upload paths for duplicate filenames', async () => {
    const root = tempRoot();
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_file_upload',
      arguments: {
        files: [
          { name: 'same.txt', content: 'first' },
          { name: 'same.txt', content: 'second' },
        ],
      },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
    });

    const paths = browserMcpMocks.clients[0]?.callTool.mock.calls[0]?.[0]
      ?.arguments?.paths as string[];
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(fs.readFileSync(paths[0]!, 'utf8')).toBe('first');
    expect(fs.readFileSync(paths[1]!, 'utf8')).toBe('second');
  });

  it('uses distinct inline upload paths for concurrent same-name requests', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await Promise.all([
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: { files: [{ name: 'same.txt', content: 'first' }] },
        session,
        fileAccessRoot: root,
      }),
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: { files: [{ name: 'same.txt', content: 'second' }] },
        session,
        fileAccessRoot: root,
      }),
    ]);

    const firstPaths = browserMcpMocks.clients[0]?.callTool.mock.calls[0]?.[0]
      ?.arguments?.paths as string[];
    const secondPaths = browserMcpMocks.clients[0]?.callTool.mock.calls[1]?.[0]
      ?.arguments?.paths as string[];
    expect(firstPaths).toHaveLength(1);
    expect(secondPaths).toHaveLength(1);
    expect(firstPaths[0]).not.toBe(secondPaths[0]);
    expect(
      [
        fs.readFileSync(firstPaths[0]!, 'utf8'),
        fs.readFileSync(secondPaths[0]!, 'utf8'),
      ].sort(),
    ).toEqual(['first', 'second']);
  });

  it('does not materialize inline upload files when the browser is not ready', async () => {
    const root = tempRoot();

    await expect(
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: {
          files: [{ name: 'note.txt', content: 'hello' }],
        },
        session: { running: false, cdpReady: false },
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('Browser is not ready');

    expect(fs.existsSync(path.join(root, 'uploads/note.txt'))).toBe(false);
  });

  it('rejects inline upload file names with path segments', async () => {
    const root = tempRoot();

    for (const name of ['../note.txt', 'nested/note.txt', 'nested\\note.txt']) {
      await expect(
        callBrowserTool({
          toolName: 'browser_file_upload',
          arguments: {
            files: [{ name, content: 'hello' }],
          },
          session: {
            running: true,
            cdpReady: true,
            port: 12345,
            profileName: 'c-main',
          },
          fileAccessRoot: root,
        }),
      ).rejects.toThrow('plain filenames');
    }
  });

  it('rejects malformed and oversized inline upload payloads', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    await expect(
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: { files: 'not-array' },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('files must be an array');
    await expect(
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: { files: ['not-object'] },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('file entries must be objects');
    await expect(
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: { files: [{ name: 'note.txt', content: 42 }] },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('content must be a string');
    await expect(
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: {
          files: [
            { name: 'note.txt', content: 'not-base64', encoding: 'base64' },
          ],
        },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('base64 content is invalid');
    await expect(
      callBrowserTool({
        toolName: 'browser_file_upload',
        arguments: {
          files: [
            {
              name: 'large.txt',
              content: 'x'.repeat(8 * 1024 * 1024 + 1),
            },
          ],
        },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('decoded bytes each');
  });

  it('infers fill_form field metadata from target and value', async () => {
    const root = tempRoot();
    browserMcpMocks.nextResult = { content: [{ type: 'text', text: 'ok' }] };

    await callBrowserTool({
      toolName: 'browser_fill_form',
      arguments: {
        fields: [
          { target: 'e1', value: 'Ravi' },
          { target: 'e2', element: 'Subscribe', value: true },
          { target: 'e3', name: 'Age', type: 'slider', value: 42 },
        ],
      },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
    });

    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenCalledWith(
      {
        name: 'browser_fill_form',
        arguments: {
          fields: [
            {
              target: 'e1',
              element: 'e1',
              name: 'e1',
              type: 'textbox',
              value: 'Ravi',
            },
            {
              target: 'e2',
              element: 'Subscribe',
              name: 'Subscribe',
              type: 'checkbox',
              value: 'true',
            },
            {
              target: 'e3',
              element: 'Age',
              name: 'Age',
              type: 'slider',
              value: '42',
            },
          ],
        },
      },
      undefined,
      { timeout: expect.any(Number) },
    );
  });

  it('rejects output paths that traverse symlinked parents', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));

    await expect(
      callBrowserTool({
        toolName: 'browser_take_screenshot',
        arguments: { filename: 'linked-dir/out.png' },
        session: {
          running: true,
          cdpReady: true,
          port: 12345,
          profileName: 'c-main',
        },
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('cannot traverse symlinks');
  });

  it('passes backend config derived by the browser proxy', async () => {
    const root = tempRoot();
    const createBackendConfig = vi.fn(() => {
      throw new Error('stop before backend connect');
    });

    await expect(
      callBrowserTool({
        toolName: 'browser_take_screenshot',
        arguments: {},
        session: {
          running: true,
          cdpReady: true,
          port: 12345,
          profileName: 'c-main',
        },
        fileAccessRoot: root,
        createBackendConfig,
      }),
    ).rejects.toThrow('stop before backend connect');

    expect(createBackendConfig).toHaveBeenCalledWith('http://127.0.0.1:12345', {
      outputDir: fs.realpathSync.native(root),
      actionTimeoutMs: 120_000,
    });
  });

  it('refreshes the snapshot once when an aria ref is stale', async () => {
    const root = tempRoot();
    browserMcpMocks.callToolImpl = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Ref e6 not found in the current page snapshot. Try capturing new snapshot.',
          },
        ],
        isError: true,
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'snapshot' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'clicked' }] });

    const result = await callBrowserTool({
      toolName: 'browser_click',
      arguments: { target: 'e6' },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
    });

    expect(result).toEqual({ content: [{ type: 'text', text: 'clicked' }] });
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      1,
      { name: 'browser_click', arguments: { target: 'e6' } },
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'browser_snapshot', arguments: {} },
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      3,
      { name: 'browser_click', arguments: { target: 'e6' } },
      undefined,
      { timeout: expect.any(Number) },
    );
  });

  it('refreshes the target model for targeted snapshot stale refs', async () => {
    const root = tempRoot();
    browserMcpMocks.callToolImpl = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Ref e6 not found in the current page snapshot. Try capturing new snapshot.',
        ),
      )
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'snapshot' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'section' }] });

    const result = await callBrowserTool({
      toolName: 'browser_snapshot',
      arguments: { target: 'e6' },
      session: {
        running: true,
        cdpReady: true,
        port: 12345,
        profileName: 'c-main',
      },
      fileAccessRoot: root,
    });

    expect(result).toEqual({ content: [{ type: 'text', text: 'section' }] });
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      1,
      { name: 'browser_snapshot', arguments: { target: 'e6' } },
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'browser_snapshot', arguments: {} },
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      3,
      { name: 'browser_snapshot', arguments: { target: 'e6' } },
      undefined,
      { timeout: expect.any(Number) },
    );
  });

  it('returns a compact file ref for screenshot filenames instead of inline image bytes', () => {
    const root = tempRoot();
    const filename = path.join(root, 'shot.png');
    const data = Buffer.from('png bytes').toString('base64');

    const result = normalizeBrowserToolResult(
      'browser_take_screenshot',
      { filename },
      {
        content: [
          { type: 'text', text: 'captured' },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      },
    );

    expect(fs.readFileSync(filename, 'utf-8')).toBe('png bytes');
    expect(JSON.stringify(result)).not.toContain(data);
    expect(result).toEqual({
      content: [{ type: 'text', text: `Saved to ${filename}` }],
      file: {
        path: filename,
        mimeType: 'image/png',
        sizeBytes: 9,
      },
    });
  });

  it('returns compact file refs for every filename-output browser tool when the backend saved the file', () => {
    const root = tempRoot();

    for (const toolName of [
      'browser_snapshot',
      'browser_console_messages',
      'browser_network_requests',
      'browser_evaluate',
    ] as const) {
      const filename = path.join(root, `${toolName}.txt`);
      fs.writeFileSync(filename, `${toolName} output`);

      const result = normalizeBrowserToolResult(
        toolName,
        { filename },
        {
          content: [
            {
              type: 'text',
              text: `${toolName} output that should be compacted`,
            },
          ],
        },
      );

      expect(result).toEqual({
        content: [{ type: 'text', text: `Saved to ${filename}` }],
        file: {
          path: filename,
          sizeBytes: Buffer.byteLength(`${toolName} output`),
        },
      });
    }
  });

  it('preserves backend-native filename tool results when no filename was supplied', () => {
    const backendResult = {
      content: [{ type: 'text', text: 'native snapshot text' }],
    };

    expect(
      normalizeBrowserToolResult('browser_snapshot', {}, backendResult),
    ).toEqual(backendResult);
  });

  it('auto-persists large inline browser snapshots without a filename', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T00:00:00.000Z'));
    const root = tempRoot();
    const largeSnapshot = 'node '.repeat(8_000);

    const result = normalizeBrowserToolResult(
      'browser_snapshot',
      {},
      { content: [{ type: 'text', text: largeSnapshot }] },
      { artifactRoot: root },
    );

    const expectedPath = path.join(
      fs.realpathSync.native(root),
      `snapshot-${Date.parse('2026-05-09T00:00:00.000Z')}.txt`,
    );
    expect(fs.readFileSync(expectedPath, 'utf8')).toBe(largeSnapshot);
    expect(JSON.stringify(result).length).toBeLessThan(12_000);
    expect(result).toMatchObject({
      file: {
        path: expectedPath,
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(largeSnapshot),
      },
    });
    expect(JSON.stringify(result)).not.toContain(largeSnapshot);
    vi.useRealTimers();
  });

  it('removes internal Chrome targets from non-tab browser tool responses', () => {
    const result = normalizeBrowserToolResult(
      'browser_navigate',
      {},
      {
        content: [
          {
            type: 'text',
            text: [
              'Navigated to https://example.test/',
              'Open tabs:',
              '- 0: Example https://example.test/',
              '- 1: chrome://omnibox-popup.top-chrome/',
              '- 2: New tab chrome://new-tab-page/',
            ].join('\n'),
          },
        ],
        structuredContent: {
          tabs: [
            { index: 0, title: 'Example', url: 'https://example.test/' },
            {
              index: 1,
              title: 'omnibox',
              url: 'chrome://omnibox-popup.top-chrome/',
            },
            { index: 2, title: 'New tab', url: 'chrome://new-tab-page/' },
          ],
        },
      },
    );

    expect(JSON.stringify(result)).not.toContain('omnibox-popup');
    expect(JSON.stringify(result)).not.toContain('new-tab-page');
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: [
            'Navigated to https://example.test/',
            'Open tabs:',
            '- 0: Example https://example.test/',
          ].join('\n'),
        },
      ],
      structuredContent: {
        tabs: [{ index: 0, title: 'Example', url: 'https://example.test/' }],
      },
    });
  });

  it('removes internal Chrome targets from tab list responses and renumbers visible tabs', () => {
    const result = sanitizeBrowserTabsResult({
      content: [
        {
          type: 'text',
          text: [
            '- 0: New Links | Hacker News https://news.ycombinator.com/newest',
            '- 1: New tab chrome://new-tab-page/',
            '- 1: chrome://omnibox-popup.top-chrome/',
            '- 4: Example https://example.test/',
          ].join('\n'),
        },
      ],
      structuredContent: {
        tabs: [
          {
            index: 0,
            title: 'New Links | Hacker News',
            url: 'https://news.ycombinator.com/newest',
          },
          { index: 1, title: 'New tab', url: 'chrome://new-tab-page/' },
          {
            index: 2,
            title: 'chrome://omnibox-popup.top-chrome',
            url: 'chrome://omnibox-popup.top-chrome/',
          },
          { index: 4, title: 'Example', url: 'https://example.test/' },
        ],
      },
    });

    expect(JSON.stringify(result)).not.toContain('omnibox-popup');
    expect(JSON.stringify(result)).not.toContain('new-tab-page');
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: [
            '- 0: New Links | Hacker News https://news.ycombinator.com/newest',
            '- 1: Example https://example.test/',
          ].join('\n'),
        },
      ],
      structuredContent: {
        tabs: [
          {
            index: 0,
            title: 'New Links | Hacker News',
            url: 'https://news.ycombinator.com/newest',
          },
          {
            index: 1,
            title: 'Example',
            url: 'https://example.test/',
          },
        ],
      },
    });
  });

  it('maps visible tab indices back to backend indices for select and close', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [
        {
          type: 'text',
          text: [
            '- 0: New Links | Hacker News https://news.ycombinator.com/newest',
            '- 1: New tab chrome://new-tab-page/',
            '- 4: Example https://example.test/',
          ].join('\n'),
        },
      ],
      structuredContent: {
        tabs: [
          {
            index: 0,
            title: 'New Links | Hacker News',
            url: 'https://news.ycombinator.com/newest',
          },
          { index: 1, title: 'New tab', url: 'chrome://new-tab-page/' },
          { index: 4, title: 'Example', url: 'https://example.test/' },
        ],
      },
    };

    const listResult = await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    expect(listResult).toMatchObject({
      structuredContent: {
        tabs: [
          { index: 0, url: 'https://news.ycombinator.com/newest' },
          { index: 1, url: 'https://example.test/' },
        ],
      },
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: 'selected' }],
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'select', index: 1 },
      session,
      fileAccessRoot: root,
    });
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'close', index: 0 },
      session,
      fileAccessRoot: root,
    });

    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'browser_tabs', arguments: { action: 'select', index: 4 } },
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      3,
      { name: 'browser_tabs', arguments: { action: 'close', index: 0 } },
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(
      browserMcpMocks.clients[0]?.callTool.mock.calls[1]?.[2]?.timeout,
    ).toBeGreaterThan(0);
    expect(
      browserMcpMocks.clients[0]?.callTool.mock.calls[1]?.[2]?.timeout,
    ).toBeLessThanOrEqual(BROWSER_ACTION_TIMEOUT_MS);
  });

  it('invalidates tab mappings after close without a fresh structured tab list', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 4: Example https://example.test/' }],
      structuredContent: {
        tabs: [{ index: 4, title: 'Example', url: 'https://example.test/' }],
      },
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: 'closed' }],
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'close', index: 0 },
      session,
      fileAccessRoot: root,
    });

    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'select', index: 0 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('needs a fresh browser_tabs list');
    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'close', index: 0 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('needs a fresh browser_tabs list');
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenCalledTimes(2);
  });

  it('invalidates tab mappings after new without a fresh structured tab list', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 4: Example https://example.test/' }],
      structuredContent: {
        tabs: [{ index: 4, title: 'Example', url: 'https://example.test/' }],
      },
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: 'opened' }],
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'new' },
      session,
      fileAccessRoot: root,
    });

    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'close', index: 0 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('needs a fresh browser_tabs list');
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenCalledTimes(2);
  });

  it('replaces tab mappings when close returns a fresh structured tab list', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 4: Example https://example.test/' }],
      structuredContent: {
        tabs: [{ index: 4, title: 'Example', url: 'https://example.test/' }],
      },
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 9: Other https://other.test/' }],
      structuredContent: {
        tabs: [{ index: 9, title: 'Other', url: 'https://other.test/' }],
      },
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'close', index: 0 },
      session,
      fileAccessRoot: root,
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: 'selected' }],
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'select', index: 0 },
      session,
      fileAccessRoot: root,
    });

    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'browser_tabs', arguments: { action: 'close', index: 4 } },
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      3,
      { name: 'browser_tabs', arguments: { action: 'select', index: 9 } },
      undefined,
      { timeout: expect.any(Number) },
    );
  });

  it('fails numeric tab select and close before backend dispatch when no mapping exists', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'select', index: 0 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('needs a fresh browser_tabs list');
    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'close', index: 0 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('needs a fresh browser_tabs list');

    expect(browserMcpMocks.clients).toHaveLength(0);
  });

  it('fails tab select and close before backend dispatch for non-finite or missing indexes', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    for (const action of ['select', 'close'] as const) {
      for (const args of [
        { action },
        { action, index: '0' },
        { action, index: null },
        { action, index: Number.NaN },
        { action, index: Infinity },
        { action, index: 0.5 },
      ]) {
        await expect(
          callBrowserTool({
            toolName: 'browser_tabs',
            arguments: args,
            session,
            fileAccessRoot: root,
          }),
        ).rejects.toThrow('requires an integer numeric index');
      }
    }

    expect(browserMcpMocks.clients).toHaveLength(0);
  });

  it('fails numeric tab select and close before backend dispatch for unknown visible indices', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 4: Example https://example.test/' }],
      structuredContent: {
        tabs: [{ index: 4, title: 'Example', url: 'https://example.test/' }],
      },
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'select', index: 1 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('is not in the current visible tab list');
    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'close', index: 1 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('is not in the current visible tab list');

    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenCalledTimes(1);
  });

  it('projects markdown-only backend tab lists into stable visible indices', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [
        {
          type: 'text',
          text: [
            '- 4: Example https://example.test/',
            '- 9: Other https://other.test/',
          ].join('\n'),
        },
      ],
    };

    const result = await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: [
            '- 0: Example https://example.test/',
            '- 1: Other https://other.test/',
          ].join('\n'),
        },
      ],
      structuredContent: {
        tabs: [
          { index: 0, title: 'Example', url: 'https://example.test/' },
          { index: 1, title: 'Other', url: 'https://other.test/' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('- 4:');
    expect(JSON.stringify(result)).not.toContain('- 9:');

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: 'selected' }],
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'select', index: 1 },
      session,
      fileAccessRoot: root,
    });

    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'browser_tabs', arguments: { action: 'select', index: 9 } },
      undefined,
      { timeout: expect.any(Number) },
    );
  });

  it('projects Playwright MCP markdown tab lists into usable select and close indices', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [
        {
          type: 'text',
          text: [
            '- 4: (current) [Example](https://example.test/)',
            '- 9: [Other](about:blank)',
          ].join('\n'),
        },
      ],
    };

    const result = await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    expect(result).toMatchObject({
      content: [
        {
          text: [
            '- 0: (current) [Example](https://example.test/)',
            '- 1: [Other](about:blank)',
          ].join('\n'),
        },
      ],
      structuredContent: {
        tabs: [
          {
            index: 0,
            title: 'Example',
            url: 'https://example.test/',
            current: true,
          },
          { index: 1, title: 'Other', url: 'about:blank' },
        ],
      },
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: 'selected' }],
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'select', index: 1 },
      session,
      fileAccessRoot: root,
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: 'closed' }],
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'close', index: 0 },
      session,
      fileAccessRoot: root,
    });

    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'browser_tabs', arguments: { action: 'select', index: 9 } },
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      3,
      { name: 'browser_tabs', arguments: { action: 'close', index: 4 } },
      undefined,
      { timeout: expect.any(Number) },
    );
  });

  it('fails closed and clears stale mapping for unparseable markdown tab lists', async () => {
    const root = tempRoot();
    const session = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 4: Example https://example.test/' }],
      structuredContent: {
        tabs: [{ index: 4, title: 'Example', url: 'https://example.test/' }],
      },
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 4: files processed' }],
    };
    const result = await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: root,
    });

    expect(result).toMatchObject({ isError: true });
    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'select', index: 0 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('needs a fresh browser_tabs list');
    await expect(
      callBrowserTool({
        toolName: 'browser_tabs',
        arguments: { action: 'close', index: 0 },
        session,
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('needs a fresh browser_tabs list');
    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenCalledTimes(2);
  });

  it('does not parse tab-shaped markdown from non-tab tool results', () => {
    const result = normalizeBrowserToolResult(
      'browser_evaluate',
      {},
      {
        content: [
          {
            type: 'text',
            text: '- 4: Example https://example.test/',
          },
        ],
      },
      { tabSessionKey: 'c-main\0http://127.0.0.1:12345' },
    );

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: '- 4: Example https://example.test/',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('structuredContent');
  });

  it('keeps visible tab index mappings isolated per browser session', async () => {
    const root = tempRoot();
    const mainSession = {
      running: true,
      cdpReady: true,
      port: 12345,
      profileName: 'c-main',
    };
    const childSession = {
      running: true,
      cdpReady: true,
      port: 12346,
      profileName: 'c-main',
    };

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 3: Main https://main.test/' }],
      structuredContent: {
        tabs: [{ index: 3, title: 'Main', url: 'https://main.test/' }],
      },
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session: mainSession,
      fileAccessRoot: root,
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: '- 8: Child https://child.test/' }],
      structuredContent: {
        tabs: [{ index: 8, title: 'Child', url: 'https://child.test/' }],
      },
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'list' },
      session: childSession,
      fileAccessRoot: root,
    });

    browserMcpMocks.nextResult = {
      content: [{ type: 'text', text: 'selected' }],
    };
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'select', index: 0 },
      session: mainSession,
      fileAccessRoot: root,
    });
    await callBrowserTool({
      toolName: 'browser_tabs',
      arguments: { action: 'select', index: 0 },
      session: childSession,
      fileAccessRoot: root,
    });

    expect(browserMcpMocks.clients[0]?.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'browser_tabs', arguments: { action: 'select', index: 3 } },
      undefined,
      { timeout: expect.any(Number) },
    );
    const mainTimeout = browserMcpMocks.clients[0]?.callTool.mock.calls[1]?.[2]
      ?.timeout as number;
    expect(mainTimeout).toBeGreaterThan(0);
    expect(mainTimeout).toBeLessThanOrEqual(BROWSER_ACTION_TIMEOUT_MS);
    expect(browserMcpMocks.clients[1]?.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'browser_tabs', arguments: { action: 'select', index: 8 } },
      undefined,
      { timeout: expect.any(Number) },
    );
    const childTimeout = browserMcpMocks.clients[1]?.callTool.mock.calls[1]?.[2]
      ?.timeout as number;
    expect(childTimeout).toBeGreaterThan(0);
    expect(childTimeout).toBeLessThanOrEqual(BROWSER_ACTION_TIMEOUT_MS);
  });

  it('names backend timeout failures distinctly from IPC timeout failures', () => {
    expect(
      formatBackendError(
        'browser_tabs',
        new Error('Timed out waiting for tab list'),
      ),
    ).toContain('Browser backend timeout');
  });
});

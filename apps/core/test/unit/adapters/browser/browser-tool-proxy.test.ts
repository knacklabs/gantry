import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/runtime/browser-cdp-targets.js', () => ({
  ensureBrowserTarget: vi.fn(async () => 'target-1'),
}));

import {
  callBrowserTool,
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('browser tool proxy file policy', () => {
  it('starts the private backend with a longer action timeout', () => {
    const config = createBrowserActionMcpServerConfig('http://127.0.0.1:12345');

    expect(config.args).toEqual(
      expect.arrayContaining([
        '--timeout-action',
        String(BROWSER_ACTION_TIMEOUT_MS),
      ]),
    );
  });

  it('sanitizes filename on snapshot, console, and evaluate before backend dispatch', async () => {
    const root = tempRoot();

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
          session: { running: false, cdpReady: false },
          fileAccessRoot: root,
        }),
      ).rejects.toThrow('limited to the run browser artifact root');
    }
  });

  it('rejects hidden and sensitive browser output path segments', async () => {
    const root = tempRoot();

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
          session: { running: false, cdpReady: false },
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
        session: { running: false, cdpReady: false },
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('regular files');
  });

  it('rejects output paths that traverse symlinked parents', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));

    await expect(
      callBrowserTool({
        toolName: 'browser_take_screenshot',
        arguments: { filename: 'linked-dir/out.png' },
        session: { running: false, cdpReady: false },
        fileAccessRoot: root,
      }),
    ).rejects.toThrow('cannot traverse symlinks');
  });

  it('passes the run extra workspace as the backend default output directory', async () => {
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
    });
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

  it('removes internal Chrome targets from tab list responses without renumbering visible tabs', () => {
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
          {
            index: 4,
            title: 'Example',
            url: 'https://example.test/',
          },
        ],
      },
    });
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

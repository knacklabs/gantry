import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const requestBrowserAction = vi.hoisted(() => vi.fn());

vi.mock('@core/runner/mcp/ipc.js', () => ({
  requestBrowserAction,
}));

vi.mock('@core/runner/mcp/formatting.js', () => ({
  formatBrowserToolResponse: (response: unknown) => JSON.stringify(response),
}));

import { registerBrowserTools } from '@core/runner/mcp/tools/browser.js';

class TestMcpServer {
  readonly tools = new Map<string, (args: unknown) => Promise<unknown>>();
  readonly schemas = new Map<string, unknown>();

  tool(
    name: string,
    _description: string,
    schema: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ) {
    this.schemas.set(name, schema);
    this.tools.set(name, handler);
  }
}

describe('runner browser MCP projected tools', () => {
  beforeEach(() => {
    requestBrowserAction.mockReset();
  });

  it('delegates browser tools to signed IPC without direct CDP probing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    requestBrowserAction.mockResolvedValueOnce({
      ok: true,
      data: {
        profile: 'myclaw',
        profileName: 'myclaw',
        running: true,
        cdpReady: true,
        port: 4567,
      },
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_status')?.({});

    expect([...server.tools.keys()]).toContain('browser_status');
    expect([...server.tools.keys()]).toContain('browser_navigate');
    expect([...server.tools.keys()]).not.toContain('browser');
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'browser_status',
      {},
      { timeoutMs: 120_000 },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            data: {
              profile: 'myclaw',
              profileName: 'myclaw',
              running: true,
              cdpReady: true,
              port: 4567,
            },
          }),
        },
      ],
    });
    vi.unstubAllGlobals();
  });

  it('clamps and forwards browser action timeout_ms to signed IPC', async () => {
    requestBrowserAction.mockResolvedValue({
      ok: true,
      data: { ok: true },
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    await server.tools.get('browser_take_screenshot')?.({
      timeout_ms: 250_000,
    });

    expect(requestBrowserAction).toHaveBeenCalledWith(
      'browser_take_screenshot',
      {},
      { timeoutMs: 120_000 },
    );

    await server.tools.get('browser_take_screenshot')?.({
      timeout_ms: 500,
    });

    expect(requestBrowserAction).toHaveBeenLastCalledWith(
      'browser_take_screenshot',
      {},
      { timeoutMs: 1_000 },
    );
  });

  it('passes through compact browser MCP results without wrapping them as JSON text', async () => {
    const compactResult = {
      content: [{ type: 'text', text: 'Saved to /tmp/browser/shot.png' }],
      file: {
        path: '/tmp/browser/shot.png',
        mimeType: 'image/png',
        sizeBytes: 12,
      },
    };
    requestBrowserAction.mockResolvedValueOnce({
      ok: true,
      data: compactResult,
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_take_screenshot')?.({
      filename: 'shot.png',
    });

    expect(result).toBe(compactResult);
  });

  it('passes simpler fill form fields and inline upload files through IPC', async () => {
    requestBrowserAction.mockResolvedValue({
      ok: true,
      data: { content: [{ type: 'text', text: 'ok' }] },
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    await server.tools.get('browser_fill_form')?.({
      fields: [{ target: 'e1', value: 'Ravi' }],
    });
    await server.tools.get('browser_file_upload')?.({
      files: [{ name: 'note.txt', content: 'hello' }],
    });

    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      1,
      'browser_fill_form',
      { fields: [{ target: 'e1', value: 'Ravi' }] },
      { timeoutMs: 120_000 },
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      2,
      'browser_file_upload',
      { files: [{ name: 'note.txt', content: 'hello' }] },
      { timeoutMs: 120_000 },
    );
    expect(server.schemas.get('browser_fill_form')).toHaveProperty('fields');
    expect(server.schemas.get('browser_file_upload')).toHaveProperty('files');
  });

  it('keeps projected browser tool schemas parseable for simplified inputs', () => {
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const fillFormSchema = z.object(
      server.schemas.get('browser_fill_form') as z.ZodRawShape,
    );
    const uploadSchema = z.object(
      server.schemas.get('browser_file_upload') as z.ZodRawShape,
    );
    const snapshotSchema = z.object(
      server.schemas.get('browser_snapshot') as z.ZodRawShape,
    );

    expect(
      fillFormSchema.safeParse({
        fields: [{ target: 'e1', value: 'Ravi' }],
      }).success,
    ).toBe(true);
    expect(
      uploadSchema.safeParse({
        paths: ['existing.txt'],
        files: [{ name: 'note.txt', content: 'hello' }],
      }).success,
    ).toBe(true);
    expect(
      snapshotSchema.safeParse({ target: 'e1', filename: 'snapshot.json' })
        .success,
    ).toBe(true);
  });
});

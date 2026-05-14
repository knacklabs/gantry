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

describe('runner browser MCP gateway tools', () => {
  beforeEach(() => {
    requestBrowserAction.mockReset();
  });

  it('registers only the compact public browser gateway tools', () => {
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    expect([...server.tools.keys()].sort()).toEqual([
      'browser_act',
      'browser_close',
      'browser_inspect',
      'browser_open',
      'browser_status',
    ]);
    expect([...server.tools.keys()]).not.toContain('browser');
  });

  it('delegates browser status to signed IPC without direct CDP probing', async () => {
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

    expect(requestBrowserAction).toHaveBeenCalledWith(
      'status',
      {},
      { timeoutMs: 120_000, publicToolName: 'browser_status' },
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

  it('opens the backend browser and then navigates when a url is provided', async () => {
    requestBrowserAction
      .mockResolvedValueOnce({ ok: true, data: { opened: true } })
      .mockResolvedValueOnce({ ok: true, data: { navigated: true } });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_open')?.({
      url: 'https://example.com',
      keep_alive_ms: 60_000,
      timeout_ms: 250_000,
    });

    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      1,
      'open',
      { keep_alive_ms: 60_000 },
      { timeoutMs: 120_000, publicToolName: 'browser_open' },
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      2,
      'navigate',
      { url: 'https://example.com' },
      { timeoutMs: 120_000, publicToolName: 'browser_open' },
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, data: { navigated: true } }),
        },
      ],
    });
  });

  it('maps compact inspect modes to backend actions', async () => {
    requestBrowserAction.mockResolvedValue({ ok: true, data: { ok: true } });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    await server.tools.get('browser_inspect')?.({
      mode: 'snapshot',
      target: 'e1',
      filename: 'snapshot.json',
    });
    await server.tools.get('browser_inspect')?.({ mode: 'tabs' });
    await server.tools.get('browser_inspect')?.({
      mode: 'screenshot',
      filename: 'shot.png',
      timeout_ms: 500,
    });

    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      1,
      'snapshot',
      { target: 'e1', filename: 'snapshot.json' },
      { timeoutMs: 120_000, publicToolName: 'browser_inspect' },
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      2,
      'tabs',
      { action: 'list' },
      { timeoutMs: 120_000, publicToolName: 'browser_inspect' },
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      3,
      'screenshot',
      { filename: 'shot.png' },
      { timeoutMs: 1_000, publicToolName: 'browser_inspect' },
    );
  });

  it('requires full profile and reason for full inspect modes', async () => {
    requestBrowserAction.mockResolvedValue({ ok: true, data: { ok: true } });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const blocked = await server.tools.get('browser_inspect')?.({
      mode: 'console_messages',
    });
    await server.tools.get('browser_inspect')?.({
      mode: 'network_requests',
      profile: 'full',
      reason: 'Debug failing request.',
      filename: 'network.json',
    });

    expect(blocked).toMatchObject({ isError: true });
    expect(requestBrowserAction).toHaveBeenCalledTimes(1);
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'network_requests',
      { filename: 'network.json' },
      { timeoutMs: 120_000, publicToolName: 'browser_inspect' },
    );
  });

  it('maps compact basic browser actions to backend actions', async () => {
    requestBrowserAction.mockResolvedValue({ ok: true, data: { ok: true } });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    await server.tools.get('browser_act')?.({
      action: 'navigate',
      payload: { url: 'https://example.com' },
    });
    await server.tools.get('browser_act')?.({
      action: 'tab_select',
      payload: { index: 1 },
    });
    await server.tools.get('browser_act')?.({
      action: 'click',
      payload: { target: 'button[name=save]' },
    });
    await server.tools.get('browser_act')?.({
      action: 'back',
      payload: { ignored: true },
    });

    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      1,
      'navigate',
      { url: 'https://example.com' },
      { timeoutMs: 120_000, publicToolName: 'browser_act' },
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      2,
      'tabs',
      { index: 1, action: 'select' },
      { timeoutMs: 120_000, publicToolName: 'browser_act' },
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      3,
      'click',
      { target: 'button[name=save]' },
      { timeoutMs: 120_000, publicToolName: 'browser_act' },
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      4,
      'back',
      {},
      { timeoutMs: 120_000, publicToolName: 'browser_act' },
    );
  });

  it('requires full profile and reason for full browser actions', async () => {
    requestBrowserAction.mockResolvedValue({ ok: true, data: { ok: true } });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const blocked = await server.tools.get('browser_act')?.({
      action: 'evaluate',
      payload: { function: '() => document.title' },
      profile: 'full',
    });
    await server.tools.get('browser_act')?.({
      action: 'evaluate',
      profile: 'full',
      reason: 'Read page title for verification.',
      payload: { function: '() => document.title' },
    });

    expect(blocked).toMatchObject({ isError: true });
    expect(requestBrowserAction).toHaveBeenCalledTimes(1);
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'evaluate',
      { function: '() => document.title' },
      { timeoutMs: 120_000, publicToolName: 'browser_act' },
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

    const result = await server.tools.get('browser_act')?.({
      action: 'screenshot',
      payload: { filename: 'shot.png' },
    });

    expect(result).toBe(compactResult);
  });

  it('keeps public browser gateway schemas parseable', () => {
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const openSchema = z.object(
      server.schemas.get('browser_open') as z.ZodRawShape,
    );
    const inspectSchema = z.object(
      server.schemas.get('browser_inspect') as z.ZodRawShape,
    );
    const actSchema = z.object(
      server.schemas.get('browser_act') as z.ZodRawShape,
    );

    expect(openSchema.safeParse({ url: 'https://example.com' }).success).toBe(
      true,
    );
    expect(
      inspectSchema.safeParse({
        mode: 'screenshot',
        filename: 'snapshot.png',
      }).success,
    ).toBe(true);
    expect(
      actSchema.safeParse({
        action: 'fill_form',
        profile: 'full',
        reason: 'Fill required checkout fields.',
        payload: { fields: [{ target: 'e1', value: 'Ravi' }] },
      }).success,
    ).toBe(true);
    expect(openSchema.shape).not.toHaveProperty('headless');
  });
});

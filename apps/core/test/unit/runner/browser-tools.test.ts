import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const requestBrowserAction = vi.hoisted(() => vi.fn());
const requestCaptchaVisionAction = vi.hoisted(() => vi.fn());
const handleFileToolAction = vi.hoisted(() => vi.fn());

vi.mock('@core/runner/mcp/ipc.js', () => ({
  requestBrowserAction,
  requestCaptchaVisionAction,
}));

vi.mock('@core/runner/mcp/formatting.js', () => ({
  formatBrowserToolResponse: (response: unknown) => JSON.stringify(response),
}));

vi.mock('@core/runner/mcp/tools/file.js', () => ({
  handleFileToolAction,
}));

import {
  registerBrowserTools,
  settleCaptchaChallenge,
} from '@core/runner/mcp/tools/browser.js';

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

function discoveredCaptchaControls(
  inputTarget = '#captcha-answer',
  submitTarget: string | null = '#captcha-submit',
  resultRowCount?: number,
) {
  return {
    ok: true,
    data: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ inputTarget, submitTarget, resultRowCount }),
        },
      ],
    },
  };
}

describe('runner browser MCP gateway tools', () => {
  beforeEach(() => {
    requestBrowserAction.mockReset();
    requestCaptchaVisionAction.mockReset();
    requestCaptchaVisionAction.mockResolvedValue({
      ok: true,
      data: { solved: false },
    });
    handleFileToolAction.mockReset();
    handleFileToolAction.mockResolvedValue(
      JSON.stringify({
        artifact: {
          id: 'file-artifact:00000000-0000-4000-8000-000000000001',
          contentHash: 'sha256:test',
        },
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('registers only the compact public browser gateway tools', () => {
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    expect([...server.tools.keys()].sort()).toEqual([
      'browser_act',
      'browser_captcha_challenge',
      'browser_captcha_settle',
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
        profile: 'gantry',
        profileName: 'gantry',
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
              profile: 'gantry',
              profileName: 'gantry',
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

  it('returns operator error copy when the browser backend rejects an action', async () => {
    requestBrowserAction.mockResolvedValueOnce({
      ok: false,
      error: 'CDP connection refused',
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_status')?.({});

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: [
            'Browser action failed.',
            'cause: status: CDP connection refused',
            'recover: run gantry status and retry after the browser is ready.',
          ].join('\n'),
        },
      ],
      isError: true,
    });
  });

  it('returns repairable browser action input failures as model observations', async () => {
    requestBrowserAction.mockResolvedValueOnce({
      ok: false,
      error: 'Browser action requires function.',
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_act')?.({
      action: 'evaluate',
      profile: 'full',
      reason: 'Inspect the current page.',
      payload: {},
    });

    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('Browser action requires function.'),
        },
      ],
    });
    expect(result).not.toHaveProperty('isError');
  });

  it('returns page evaluation exceptions as repairable model observations', async () => {
    requestBrowserAction.mockResolvedValueOnce({
      ok: false,
      error:
        "page.evaluate: TypeError: Cannot read properties of null (reading 'querySelectorAll')",
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_act')?.({
      action: 'evaluate',
      profile: 'full',
      reason: 'Inspect the current page.',
      payload: {
        function: '() => document.querySelector("missing").textContent',
      },
    });

    expect(result).not.toHaveProperty('isError');
  });

  it('allows payload-free browser actions such as back', async () => {
    requestBrowserAction.mockResolvedValueOnce({
      ok: true,
      data: { ok: true },
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    await server.tools.get('browser_act')?.({ action: 'back' });

    expect(requestBrowserAction).toHaveBeenCalledWith(
      'back',
      {},
      { timeoutMs: 120_000, publicToolName: 'browser_act' },
    );
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
    await server.tools.get('browser_act')?.({
      action: 'file_attach',
      profile: 'full',
      reason: 'Attach a generated report to the current upload input.',
      payload: {
        target: 'upload-input',
        source: { type: 'path', path: '/tmp/report.zip' },
      },
    });

    expect(blocked).toMatchObject({ isError: true });
    expect(requestBrowserAction).toHaveBeenCalledTimes(2);
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      1,
      'evaluate',
      { function: '() => document.title' },
      { timeoutMs: 120_000, publicToolName: 'browser_act' },
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      2,
      'file_attach',
      {
        target: 'upload-input',
        source: { type: 'path', path: '/tmp/report.zip' },
      },
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

    expect(result).toStrictEqual(compactResult);
  });

  it('automatically submits a vision answer without returning it to the agent', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-1');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-1');
    requestCaptchaVisionAction.mockResolvedValueOnce({
      ok: true,
      data: { solved: true, answer: 'ephemeral-secret' },
    });
    let submitted = false;
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [
              {
                type: 'text',
                text: `URL: https://tenders.test/list${submitted ? '\nTender Title Opening Date Tender ID Closing Date Published Date' : ''}`,
              },
            ],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        };
      }
      if (action === 'click') submitted = true;
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text:
        'Tender ID Tender Title Published Date Closing Date Opening Date',
    });

    expect(requestBrowserAction).toHaveBeenCalledWith(
      'fill_form',
      {
        fields: [
          {
            target: '#captcha-answer',
            type: 'textbox',
            value: 'ephemeral-secret',
          },
        ],
      },
      expect.objectContaining({
        publicToolName: 'browser_captcha_settle',
        timeoutMs: 30_000,
      }),
    );
    expect(requestCaptchaVisionAction).toHaveBeenCalledWith(
      expect.objectContaining({ imageBase64: 'aW1hZ2U=' }),
      120_000,
    );
    expect(JSON.stringify(result)).not.toContain('ephemeral-secret');
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
    expect(handleFileToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"outcome":"solved_automatic"'),
      }),
    );
  });

  it('waits for protected CAPTCHA content that loads after submission', async () => {
    vi.useFakeTimers();
    vi.stubEnv('GANTRY_JOB_ID', 'job-delayed-captcha');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-delayed-captcha');
    requestCaptchaVisionAction.mockResolvedValueOnce({
      ok: true,
      data: { solved: true, answer: 'ephemeral-secret' },
    });
    let submitted = false;
    let postSubmitSnapshots = 0;
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        if (submitted) postSubmitSnapshots += 1;
        return {
          ok: true,
          data: {
            content: [
              {
                type: 'text',
                text: `URL: https://tenders.test/list${postSubmitSnapshots >= 3 ? '\nProtected results loaded' : ''}`,
              },
            ],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        };
      }
      if (action === 'click') submitted = true;
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const resultPromise = server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    });
    await vi.advanceTimersByTimeAsync(4_500);
    const result = await resultPromise;

    expect(postSubmitSnapshots).toBe(3);
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
    expect(handleFileToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"outcome":"solved_automatic"'),
      }),
    );
  });

  it('accepts any validated post-gate result state from success_texts', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-multi-proof-captcha');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-multi-proof-captcha');
    requestCaptchaVisionAction.mockResolvedValueOnce({
      ok: true,
      data: { solved: true, answer: 'ephemeral-secret' },
    });
    let submitted = false;
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [
              {
                type: 'text',
                text: `URL: https://tenders.test/list${submitted ? '\nTender ID Tender Title' : ''}`,
              },
            ],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        };
      }
      if (action === 'click') submitted = true;
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_texts: ['Tender ID Tender Title', 'No Records Found'],
    });

    expect(JSON.stringify(result)).toContain(
      'success text Tender ID Tender Title',
    );
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
  });

  it('proves newly loaded data rows even when the results page retains a CAPTCHA widget', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-retained-captcha');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-retained-captcha');
    requestCaptchaVisionAction.mockResolvedValueOnce({
      ok: true,
      data: { solved: true, answer: 'ephemeral-secret' },
    });
    let submitted = false;
    requestBrowserAction.mockImplementation(
      async (action: string, payload: Record<string, unknown>) => {
        if (action === 'evaluate') {
          if (
            String(payload.function).startsWith('() =>') &&
            String(payload.function).includes("querySelectorAll('table tr')")
          ) {
            return {
              ok: true,
              data: {
                content: [
                  { type: 'text', text: JSON.stringify(submitted ? 12 : 0) },
                ],
              },
            };
          }
          return discoveredCaptchaControls(
            '#captcha-answer',
            '#captcha-submit',
            0,
          );
        }
        if (action === 'snapshot') {
          return {
            ok: true,
            data: {
              content: [
                {
                  type: 'text',
                  text: submitted
                    ? 'URL: https://tenders.test/list\nEnter CAPTCHA\nTender Reference Organisation Closing Date'
                    : 'URL: https://tenders.test/list\nEnter CAPTCHA',
                },
              ],
            },
          };
        }
        if (action === 'screenshot') {
          return {
            ok: true,
            data: {
              content: [
                { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
              ],
            },
          };
        }
        if (action === 'click') submitted = true;
        return { ok: true, data: { [action]: true } };
      },
    );
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'No records found',
    });

    expect(JSON.stringify(result)).toContain(
      'new protected data rows appeared',
    );
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
  });

  it('proves a populated protected page when the CAPTCHA gate disappears', async () => {
    vi.useFakeTimers();
    vi.stubEnv('GANTRY_JOB_ID', 'job-gate-disappeared');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-gate-disappeared');
    requestCaptchaVisionAction.mockResolvedValueOnce({
      ok: true,
      data: { solved: true, answer: 'ephemeral-secret' },
    });
    let submitted = false;
    requestBrowserAction.mockImplementation(
      async (action: string, payload: Record<string, unknown>) => {
        if (action === 'evaluate') {
          if (String(payload.function).includes('preferredInputSelector'))
            return discoveredCaptchaControls();
          return {
            ok: true,
            data: {
              content: [{ type: 'text', text: JSON.stringify(!submitted) }],
            },
          };
        }
        if (action === 'snapshot') {
          return {
            ok: true,
            data: {
              content: [
                {
                  type: 'text',
                  text: submitted
                    ? 'URL: https://tenders.test/list\nTender Reference Number Organisation Published Date Closing Date View Documents'
                    : 'URL: https://tenders.test/list\nEnter CAPTCHA to continue',
                },
              ],
            },
          };
        }
        if (action === 'screenshot') {
          return {
            ok: true,
            data: {
              content: [
                { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
              ],
            },
          };
        }
        if (action === 'click') submitted = true;
        return { ok: true, data: { [action]: true } };
      },
    );
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const resultPromise = server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'No Records Found',
    });
    await vi.advanceTimersByTimeAsync(16_000);
    const result = await resultPromise;

    expect(JSON.stringify(result)).toContain(
      'challenge image and answer control disappeared',
    );
    expect(handleFileToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"outcome":"solved_automatic"'),
      }),
    );
    expect(requestBrowserAction).not.toHaveBeenCalledWith(
      'back',
      expect.anything(),
      expect.anything(),
    );
  });

  it('checks a success_target through DOM presence instead of screenshot text fallback', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-selector-proof-captcha');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-selector-proof-captcha');
    requestCaptchaVisionAction.mockResolvedValueOnce({
      ok: true,
      data: { solved: true, answer: 'ephemeral-secret' },
    });
    let submitted = false;
    requestBrowserAction.mockImplementation(
      async (action: string, payload: Record<string, unknown>) => {
        if (action === 'evaluate') {
          if (payload.target === '#protected-results') {
            return {
              ok: true,
              data: {
                content: [{ type: 'text', text: JSON.stringify(submitted) }],
              },
            };
          }
          return discoveredCaptchaControls();
        }
        if (action === 'snapshot') {
          return {
            ok: true,
            data: {
              content: [
                { type: 'text', text: 'URL: https://tenders.test/list' },
              ],
            },
          };
        }
        if (action === 'screenshot') {
          return {
            ok: true,
            data: {
              content: [
                { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
              ],
            },
          };
        }
        if (action === 'click') submitted = true;
        return { ok: true, data: { [action]: true } };
      },
    );
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_target: '#protected-results',
    });

    expect(JSON.stringify(result)).toContain(
      'success target #protected-results',
    );
    expect(requestBrowserAction).not.toHaveBeenCalledWith(
      'screenshot',
      expect.objectContaining({ target: '#protected-results' }),
      expect.anything(),
    );
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'evaluate',
      expect.objectContaining({ target: '#protected-results' }),
      expect.anything(),
    );
  });

  it('rejects a CAPTCHA input target that is not an editable text field', async () => {
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') {
        return {
          ok: true,
          data: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error:
                    'no visible editable CAPTCHA input could be found near the challenge image',
                }),
              },
            ],
          },
        };
      }
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [{ type: 'text', text: 'URL: https://tenders.test/list' }],
          },
        };
      }
      if (action === 'fill_form') {
        return {
          ok: false,
          error: 'locator.fill: Input of type "radio" cannot be filled',
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        };
      }
      return { ok: true, data: { [action]: true } };
    });
    requestCaptchaVisionAction.mockResolvedValue({
      ok: true,
      data: { solved: true, answer: 'A7z9' },
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const rejected = await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#published',
      success_text: 'Protected results loaded',
    });

    expect(rejected).toMatchObject({ isError: true });
    expect(JSON.stringify(rejected)).toContain(
      'no visible editable CAPTCHA input',
    );
    expect(requestCaptchaVisionAction).not.toHaveBeenCalled();
  });

  it('auto-discovers a CAPTCHA image when the requested target is dynamic', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-dynamic-captcha');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-dynamic-captcha');
    requestBrowserAction
      .mockResolvedValueOnce({
        ok: true,
        data: {
          content: [{ type: 'text', text: 'URL: https://tenders.test/list' }],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'Browser backend timed out while running screenshot.',
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          content: [
            { type: 'image', data: 'dmlld3BvcnQ=', mimeType: 'image/png' },
          ],
        },
      })
      .mockResolvedValueOnce(discoveredCaptchaControls())
      .mockResolvedValueOnce({ ok: true, data: { status: 'running' } });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const captured = (await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#animated-captcha',
      input_target: '#captcha-answer',
      success_text: 'Protected results loaded',
    })) as { content: Array<{ text?: string }>; isError?: boolean };

    expect(captured.isError).not.toBe(true);
    expect(captured.content[0]?.text).toContain(
      'Capture: auto_target_fallback',
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      3,
      'screenshot',
      expect.objectContaining({ target: expect.stringContaining('captcha') }),
      expect.objectContaining({
        publicToolName: 'browser_captcha_challenge',
        timeoutMs: 30_000,
      }),
    );
  });

  it('falls back when a CAPTCHA selector captures only a small page control', async () => {
    const tinyPng = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(tinyPng);
    tinyPng.writeUInt32BE(18, 16);
    tinyPng.writeUInt32BE(18, 20);
    requestBrowserAction
      .mockResolvedValueOnce({
        ok: true,
        data: {
          content: [{ type: 'text', text: 'URL: https://tenders.test/list' }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          content: [
            {
              type: 'image',
              data: tinyPng.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          content: [
            { type: 'image', data: 'dmlld3BvcnQ=', mimeType: 'image/png' },
          ],
        },
      })
      .mockResolvedValueOnce(discoveredCaptchaControls())
      .mockResolvedValueOnce({ ok: true, data: { status: 'running' } });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const captured = (await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      success_text: 'Protected results loaded',
    })) as { content: Array<{ text?: string }>; isError?: boolean };

    expect(captured.isError).not.toBe(true);
    expect(captured.content[0]?.text).toContain(
      'Capture: auto_target_fallback',
    );
    expect(requestBrowserAction).toHaveBeenNthCalledWith(
      3,
      'screenshot',
      expect.objectContaining({ target: expect.stringContaining('captcha') }),
      expect.objectContaining({ publicToolName: 'browser_captcha_challenge' }),
    );
  });

  it('rejects blank captures without consuming an automatic attempt', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-blank-captcha');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-blank-captcha');
    const blankPng = Buffer.alloc(4_789);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(blankPng);
    blankPng.writeUInt32BE(1_280, 16);
    blankPng.writeUInt32BE(813, 20);
    let blank = true;
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate')
        return discoveredCaptchaControls('#captcha-answer', null);
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [{ type: 'text', text: 'URL: https://tenders.test/list' }],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              {
                type: 'image',
                data: blank ? blankPng.toString('base64') : 'aW1hZ2U=',
                mimeType: 'image/png',
              },
            ],
          },
        };
      }
      return { ok: true, data: { [action]: true } };
    });
    requestCaptchaVisionAction.mockResolvedValue({
      ok: true,
      data: { solved: false, failureCode: 'vision_provider_rejected' },
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const rejected = await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      success_text: 'Protected results loaded',
    });
    expect(rejected).toMatchObject({ isError: true });
    expect(requestCaptchaVisionAction).not.toHaveBeenCalled();

    blank = false;
    const firstRealAttempt = (await server.tools.get(
      'browser_captcha_challenge',
    )?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      success_text: 'Protected results loaded',
    })) as { content: Array<{ text?: string }> };
    expect(firstRealAttempt.content[0]?.text).toContain(
      'All 4 automatic CAPTCHA attempts were inconclusive',
    );
    expect(firstRealAttempt.content[0]?.text).toMatch(
      /Fingerprint: sha256:[a-f0-9]{64}/u,
    );
    expect(requestCaptchaVisionAction).toHaveBeenCalledTimes(4);
    expect(handleFileToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          '"failureCode":"vision_provider_rejected"',
        ),
      }),
    );
  });

  it('rejects page-sized CAPTCHA captures instead of showing them to an administrator', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-page-sized-captcha');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-page-sized-captcha');
    const pagePng = Buffer.alloc(700_000, 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pagePng);
    pagePng.writeUInt32BE(1_280, 16);
    pagePng.writeUInt32BE(813, 20);
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'text', text: 'URL: https://tenders.test/detail' },
            ],
          },
        };
      }
      return {
        ok: true,
        data: {
          content: [
            {
              type: 'image',
              data: pagePng.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        },
      };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const rejected = await server.tools.get('browser_captcha_challenge')?.({
      image_target: 'body',
      input_target: '#captcha-answer',
      success_text: 'Protected results loaded',
    });

    expect(rejected).toMatchObject({ isError: true });
    expect(requestCaptchaVisionAction).not.toHaveBeenCalled();
    expect(requestBrowserAction).toHaveBeenCalledTimes(3);
  });

  it('allows human settlement only after four inconclusive automatic attempts', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-2');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-2');
    let omitNextSnapshotUrl = false;
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        if (omitNextSnapshotUrl) {
          omitNextSnapshotUrl = false;
          return {
            ok: true,
            data: { content: [{ type: 'text', text: 'CAPTCHA form' }] },
          };
        }
        return {
          ok: true,
          data: {
            content: [{ type: 'text', text: 'URL: https://tenders.test/list' }],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        };
      }
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);
    const captured = (await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    })) as { content: Array<{ text: string }> };
    const challengeId = /using challenge (captcha_[^.\s]+)/u.exec(
      captured?.content[0]?.text ?? '',
    )?.[1];
    expect(challengeId).toBeTruthy();
    const challengeWrites = handleFileToolAction.mock.calls
      .map(
        ([input]) =>
          input as { action?: string; path?: string; content?: string },
      )
      .filter(
        (input) =>
          input.action === 'write' &&
          input.path?.startsWith('captcha-challenge/'),
      );
    expect(challengeWrites).toHaveLength(2);
    const fallbackMetadata = JSON.parse(
      challengeWrites.at(-1)?.content ?? '{}',
    ) as {
      attemptNumber?: number;
      expiresAt?: number;
    };
    expect(fallbackMetadata.attemptNumber).toBe(4);
    expect((fallbackMetadata.expiresAt ?? 0) - Date.now()).toBeGreaterThan(
      29 * 60_000,
    );
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'open',
      { keep_alive_ms: 30 * 60_000 },
      expect.objectContaining({ publicToolName: 'browser_captcha_challenge' }),
    );

    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-2-stale');
    const stale = await server.tools.get('browser_captcha_settle')?.({
      challenge_id: challengeId,
      answer: 'stale-answer',
    });
    expect(stale).toMatchObject({ isError: true });
    expect(JSON.stringify(stale)).toContain('another run');

    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-2');
    omitNextSnapshotUrl = true;
    const settled = await server.tools.get('browser_captcha_settle')?.({
      challenge_id: challengeId,
      answer: 'human-answer',
    });
    expect(JSON.stringify(settled)).not.toContain('human-answer');
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'fill_form',
      expect.objectContaining({
        fields: [expect.objectContaining({ value: 'human-answer' })],
      }),
      expect.objectContaining({ publicToolName: 'browser_captcha_settle' }),
    );
    expect(JSON.stringify(settled)).toContain(
      'authorized answer did not clear the CAPTCHA gate',
    );

    requestCaptchaVisionAction.mockClear();
    await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    });
    expect(requestCaptchaVisionAction).toHaveBeenCalledTimes(4);
  });

  it('does not submit a human answer after the live CAPTCHA changes', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-stale-human-captcha');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-stale-human-captcha');
    let captchaChanged = false;
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [{ type: 'text', text: 'URL: https://tenders.test/list' }],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              {
                type: 'image',
                data: captchaChanged ? 'ZnJlc2g=' : 'c3RhbGU=',
                mimeType: 'image/png',
              },
            ],
          },
        };
      }
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);
    const captured = (await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    })) as { content: Array<{ text: string }> };
    const challengeId = /using challenge (captcha_[^.\s]+)/u.exec(
      captured.content[0]?.text ?? '',
    )?.[1];
    captchaChanged = true;

    const settled = await server.tools.get('browser_captcha_settle')?.({
      challenge_id: challengeId,
      answer: 'answer-for-old-image',
    });

    expect(requestBrowserAction).not.toHaveBeenCalledWith(
      'fill_form',
      expect.objectContaining({
        fields: [expect.objectContaining({ value: 'answer-for-old-image' })],
      }),
      expect.anything(),
    );
    expect(requestCaptchaVisionAction).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(settled)).toContain(
      'automatic CAPTCHA attempts were inconclusive',
    );
  });

  it('recovers a fresh automatic challenge when the browser session expired during human wait', async () => {
    vi.useFakeTimers();
    vi.stubEnv('GANTRY_JOB_ID', 'job-human-session-recovery');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-human-session-recovery');
    let waitingForHuman = false;
    let recovered = false;
    let submitted = false;
    requestCaptchaVisionAction
      .mockResolvedValueOnce({ ok: true, data: { solved: false } })
      .mockResolvedValueOnce({ ok: true, data: { solved: false } })
      .mockResolvedValueOnce({ ok: true, data: { solved: false } })
      .mockResolvedValueOnce({ ok: true, data: { solved: false } })
      .mockResolvedValueOnce({
        ok: true,
        data: { solved: true, answer: 'fresh-automatic-answer' },
      });
    requestBrowserAction.mockImplementation(
      async (action: string, payload: Record<string, unknown>) => {
        if (action === 'evaluate') return discoveredCaptchaControls();
        if (action === 'snapshot') {
          return {
            ok: true,
            data: {
              content: [
                {
                  type: 'text',
                  text:
                    waitingForHuman && !recovered
                      ? 'URL: about:blank'
                      : `URL: https://tenders.test/list${submitted ? '\nProtected results loaded' : ''}`,
                },
              ],
            },
          };
        }
        if (action === 'screenshot') {
          return waitingForHuman && !recovered
            ? { ok: false, error: 'no CAPTCHA on about:blank' }
            : {
                ok: true,
                data: {
                  content: [
                    {
                      type: 'image',
                      data: 'Y2FwdGNoYQ==',
                      mimeType: 'image/png',
                    },
                  ],
                },
              };
        }
        if (action === 'navigate') recovered = true;
        if (action === 'click') submitted = true;
        return { ok: true, data: { [action]: payload } };
      },
    );
    const server = new TestMcpServer();
    registerBrowserTools(server as never);
    const captured = (await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    })) as { content: Array<{ text: string }> };
    const challengeId = /using challenge (captcha_[^.\s]+)/u.exec(
      captured.content[0]?.text ?? '',
    )?.[1];
    waitingForHuman = true;

    const resultPromise = server.tools.get('browser_captcha_settle')?.({
      challenge_id: challengeId,
      answer: 'stale-human-answer',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(recovered).toBe(true);
    expect(requestCaptchaVisionAction).toHaveBeenCalledTimes(5);
    expect(requestBrowserAction).not.toHaveBeenCalledWith(
      'fill_form',
      expect.objectContaining({
        fields: [expect.objectContaining({ value: 'stale-human-answer' })],
      }),
      expect.anything(),
    );
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
  });

  it('owns refreshed automatic retries inside one typed challenge call', async () => {
    vi.useFakeTimers();
    vi.stubEnv('GANTRY_JOB_ID', 'job-auto-retry');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-auto-retry');
    let submissions = 0;
    requestCaptchaVisionAction
      .mockResolvedValueOnce({
        ok: true,
        data: { solved: true, answer: 'wrong1' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { solved: true, answer: 'right2' },
      });
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [
              {
                type: 'text',
                text: `URL: https://tenders.test/list${submissions >= 2 ? '\nProtected results loaded' : ''}`,
              },
            ],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        };
      }
      if (action === 'click') submissions += 1;
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const resultPromise = server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(requestCaptchaVisionAction).toHaveBeenCalledTimes(2);
    expect(submissions).toBe(2);
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
    expect(handleFileToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"outcome":"solved_automatic"'),
      }),
    );
  });

  it('retains the browser after four submitted automatic answers need human fallback', async () => {
    vi.useFakeTimers();
    vi.stubEnv('GANTRY_JOB_ID', 'job-submitted-fallback');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-submitted-fallback');
    requestCaptchaVisionAction.mockResolvedValue({
      ok: true,
      data: { solved: true, answer: 'wrong-answer' },
    });
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [{ type: 'text', text: 'URL: https://tenders.test/list' }],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'Y2FwdGNoYQ==', mimeType: 'image/png' },
            ],
          },
        };
      }
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const resultPromise = server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    });
    await vi.advanceTimersByTimeAsync(80_000);
    const result = await resultPromise;

    expect(requestCaptchaVisionAction).toHaveBeenCalledTimes(4);
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'open',
      { keep_alive_ms: 30 * 60_000 },
      expect.objectContaining({ publicToolName: 'browser_captcha_challenge' }),
    );
    expect(JSON.stringify(result)).toContain(
      'automatic attempts are exhausted',
    );
  });

  it('re-resolves snapshot refs to durable CAPTCHA controls before refreshed retries', async () => {
    vi.useFakeTimers();
    vi.stubEnv('GANTRY_JOB_ID', 'job-refreshed-controls');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-refreshed-controls');
    let submissions = 0;
    const filledTargets: string[] = [];
    const clickedTargets: string[] = [];
    requestCaptchaVisionAction
      .mockResolvedValueOnce({
        ok: true,
        data: { solved: true, answer: 'wrong1' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { solved: true, answer: 'right2' },
      });
    requestBrowserAction.mockImplementation(
      async (action: string, payload: Record<string, unknown>) => {
        if (action === 'snapshot') {
          return {
            ok: true,
            data: {
              content: [
                {
                  type: 'text',
                  text: `URL: https://tenders.test/list${submissions >= 2 ? '\nProtected results loaded' : ''}`,
                },
              ],
            },
          };
        }
        if (action === 'evaluate') {
          if (String(payload.function).includes('document.querySelector')) {
            return {
              ok: true,
              data: {
                content: [{ type: 'text', text: JSON.stringify(false) }],
              },
            };
          }
          if (String(payload.function).startsWith('(image)')) {
            return discoveredCaptchaControls();
          }
          const selectorByRef: Record<string, string> = {
            e1: '#captcha-image',
            e2: '#captcha-answer',
            e3: '#captcha-submit',
          };
          return {
            ok: true,
            data: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(selectorByRef[String(payload.target)]),
                },
              ],
            },
          };
        }
        if (action === 'screenshot') {
          return {
            ok: true,
            data: {
              content: [
                { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
              ],
            },
          };
        }
        if (action === 'fill_form') {
          const fields = payload.fields as Array<{ target: string }>;
          filledTargets.push(fields[0]?.target ?? '');
          if (submissions > 0 && fields[0]?.target === 'e2') {
            return {
              ok: false,
              error:
                'locator.fill: stale CAPTCHA ref resolved to a radio input',
            };
          }
        }
        if (action === 'click') {
          clickedTargets.push(String(payload.target));
          submissions += 1;
        }
        return { ok: true, data: { [action]: true } };
      },
    );
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const resultPromise = server.tools.get('browser_captcha_challenge')?.({
      image_target: 'e1',
      input_target: 'e2',
      submit_target: 'e3',
      success_text: 'Protected results loaded',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(filledTargets).toEqual(['#captcha-answer', '#captcha-answer']);
    expect(clickedTargets).toEqual(['#captcha-submit', '#captcha-submit']);
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
  });

  it('replaces a model-selected submit button with the live editable CAPTCHA field', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-control-discovery');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-control-discovery');
    let submitted = false;
    let discoveryFunction = '';
    requestCaptchaVisionAction.mockResolvedValueOnce({
      ok: true,
      data: { solved: true, answer: 'vision-answer' },
    });
    requestBrowserAction.mockImplementation(
      async (action: string, payload: Record<string, unknown>) => {
        if (action === 'snapshot') {
          return {
            ok: true,
            data: {
              content: [
                {
                  type: 'text',
                  text: `URL: https://tenders.test/list${submitted ? '\nSearch Results' : ''}`,
                },
              ],
            },
          };
        }
        if (action === 'screenshot') {
          return {
            ok: true,
            data: {
              content: [
                { type: 'image', data: 'Y2FwdGNoYQ==', mimeType: 'image/png' },
              ],
            },
          };
        }
        if (action === 'evaluate') {
          discoveryFunction = String(payload.function);
          return discoveredCaptchaControls(
            '#captchaText',
            'input[value="Search"]',
          );
        }
        if (action === 'click') submitted = true;
        return { ok: true, data: { [action]: true } };
      },
    );
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captchaImage',
      input_target: '#Submit',
      submit_with_enter: true,
      success_text: 'Search Results',
    });

    expect(discoveryFunction).toContain(
      'const preferredInputSelector = "#Submit"',
    );
    expect(discoveryFunction).toContain('element === preferredInput ? 50 : 0');
    expect(discoveryFunction).toContain(
      'if (/search|tender|published|date/.test(text)) value -= 500',
    );
    expect(discoveryFunction).toContain(
      'inputCandidates.sort((left, right) => inputScore(right) - inputScore(left))',
    );
    expect(discoveryFunction).toContain(
      'if (/refresh|reload|regenerate|new[ _-]?(captcha|code)|clear|reset|cancel|back/.test(text)) value -= 3000',
    );
    expect(discoveryFunction).toContain(
      'element === preferredSubmit ? 2000 : 0',
    );
    expect(discoveryFunction).toContain(
      "Array.from(doc.querySelectorAll('button,input[type=submit],input[type=button],input[type=image]'))",
    );
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'fill_form',
      expect.objectContaining({
        fields: [expect.objectContaining({ target: '#captchaText' })],
      }),
      expect.objectContaining({ publicToolName: 'browser_captcha_settle' }),
    );
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'click',
      { target: 'input[value="Search"]' },
      expect.objectContaining({ publicToolName: 'browser_captcha_settle' }),
    );
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
  });

  it('recovers a fresh CAPTCHA image instead of OCRing a blank page capture', async () => {
    vi.useFakeTimers();
    vi.stubEnv('GANTRY_JOB_ID', 'job-refresh-recovery');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-refresh-recovery');
    let submissions = 0;
    let recovered = false;
    requestCaptchaVisionAction
      .mockResolvedValueOnce({
        ok: true,
        data: { solved: true, answer: 'wrong1' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { solved: true, answer: 'right2' },
      });
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [
              {
                type: 'text',
                text: `URL: https://tenders.test/search${submissions >= 2 ? '\nProtected results loaded' : ''}`,
              },
            ],
          },
        };
      }
      if (action === 'screenshot') {
        if (submissions === 1 && !recovered) {
          return {
            ok: false,
            error: 'CAPTCHA image is absent on the intermediate page',
          };
        }
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        };
      }
      if (action === 'back') recovered = true;
      if (action === 'click') submissions += 1;
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const resultPromise = server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(recovered).toBe(true);
    expect(requestCaptchaVisionAction).toHaveBeenCalledTimes(2);
    expect(submissions).toBe(2);
    expect(JSON.stringify(result)).toContain(
      'Deterministic CAPTCHA success evidence',
    );
  });

  it('accepts a loaded result target even when the page keeps a fresh CAPTCHA widget', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-results-proof');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-results-proof');
    let submitted = false;
    requestBrowserAction.mockImplementation(
      async (action: string, payload: Record<string, unknown>) => {
        if (action === 'evaluate') return discoveredCaptchaControls();
        if (action === 'snapshot') {
          return {
            ok: true,
            data: {
              content: [
                {
                  type: 'text',
                  text: `URL: https://tenders.test/list${submitted ? '\nBid Submission Closing Date' : ''}`,
                },
              ],
            },
          };
        }
        if (action === 'screenshot') {
          return {
            ok: true,
            data: {
              content: [
                {
                  type: 'image',
                  data:
                    payload.target === '#results'
                      ? 'cmVzdWx0cw=='
                      : 'Y2FwdGNoYQ==',
                  mimeType: 'image/png',
                },
              ],
            },
          };
        }
        if (action === 'click') submitted = true;
        return { ok: true, data: { [action]: true } };
      },
    );
    const server = new TestMcpServer();
    registerBrowserTools(server as never);
    const captured = (await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Bid Submission Closing Date',
    })) as { content: Array<{ text: string }> };
    const challengeId = /using challenge (captcha_[^.\s]+)/u.exec(
      captured.content[0]?.text ?? '',
    )?.[1];

    const settled = await server.tools.get('browser_captcha_settle')?.({
      challenge_id: challengeId,
      answer: 'human-answer',
    });

    expect(settled?.isError).not.toBe(true);
    expect(JSON.stringify(settled)).toContain(
      'success text Bid Submission Closing Date is present',
    );
    expect(JSON.stringify(settled)).not.toContain(
      'did not clear the CAPTCHA gate',
    );
  });

  it('settles the challenge identified by validated attempt evidence', async () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-evidence-challenge');
    vi.stubEnv('GANTRY_JOB_RUN_ID', 'run-evidence-challenge');
    requestBrowserAction.mockImplementation(async (action: string) => {
      if (action === 'evaluate') return discoveredCaptchaControls();
      if (action === 'snapshot') {
        return {
          ok: true,
          data: {
            content: [{ type: 'text', text: 'URL: https://tenders.test/list' }],
          },
        };
      }
      if (action === 'screenshot') {
        return {
          ok: true,
          data: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        };
      }
      return { ok: true, data: { [action]: true } };
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);
    const captured = (await server.tools.get('browser_captcha_challenge')?.({
      image_target: '#captcha-image',
      input_target: '#captcha-answer',
      submit_target: '#captcha-submit',
      success_text: 'Protected results loaded',
    })) as { content: Array<{ text: string }> };
    const challengeId = /using challenge (captcha_[^.\s]+)/u.exec(
      captured.content[0]?.text ?? '',
    )?.[1];
    expect(challengeId).toBeTruthy();
    handleFileToolAction.mockImplementation(
      async (args: { action?: string }) =>
        args.action === 'read'
          ? JSON.stringify({
              challengeId,
              outcome: 'inconclusive',
              attemptNumber: 4,
            })
          : JSON.stringify({
              artifact: {
                id: 'file-artifact:00000000-0000-4000-8000-000000000001',
                contentHash: 'sha256:test',
              },
            }),
    );

    const settled = await settleCaptchaChallenge(
      'model-omitted-or-invalid-id',
      'human-answer',
      30_000,
      'human',
      'file-artifact:00000000-0000-4000-8000-000000000002',
    );

    expect(settled.isError).toBe(true);
    expect(requestBrowserAction).toHaveBeenCalledWith(
      'fill_form',
      expect.objectContaining({
        fields: [expect.objectContaining({ value: 'human-answer' })],
      }),
      expect.objectContaining({ publicToolName: 'browser_captcha_settle' }),
    );
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
    expect(
      actSchema.safeParse({
        action: 'file_attach',
        profile: 'full',
        reason: 'Upload a generated artifact.',
        payload: {
          target: 'file-input',
          source: { type: 'bytes', name: 'a.txt', content: 'hello' },
        },
      }).success,
    ).toBe(true);
    expect(openSchema.shape).not.toHaveProperty('headless');
  });
});

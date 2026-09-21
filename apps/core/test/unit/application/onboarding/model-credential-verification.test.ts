import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeProbe } from '@core/application/onboarding/model-credential-verification.js';
import type { ModelCatalogEntry } from '@core/shared/model-catalog.js';

function toolCapableEntry(
  overrides: Partial<ModelCatalogEntry['capabilities']> = {},
  modelRoute: ModelCatalogEntry['modelRoute'] = {
    id: 'bedrock',
    label: 'Bedrock Kimi K2.5',
    providerModelId: 'moonshotai.kimi-k2.5',
  },
): ModelCatalogEntry {
  return {
    responseFamily: 'openai-chat-completions',
    modelRoute,
    capabilities: {
      streaming: true,
      toolUse: true,
      mcpProjection: false,
      browserProjection: false,
      sandboxProjection: false,
      providerSessionResume: false,
      thinking: false,
      tokenAccounting: false,
      cacheAccounting: false,
      structuredOutput: false,
      ...overrides,
    },
  } as unknown as ModelCatalogEntry;
}

function sseResponse(status: number, lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

const TOOL_CALL_LINES = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"gantry_probe_echo","arguments":"{\\"value\\":\\"GANTRY_MODEL_OK\\"}"}}]}}]}\n\n',
  'data: [DONE]\n\n',
];
const NO_TOOL_CALL_LINES = [
  'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  'data: [DONE]\n\n',
];

const baseInput = {
  baseUrl: 'http://127.0.0.1:9999',
  token: 'gtw_test',
  providerLabel: 'Amazon Bedrock',
  timeoutMs: 5_000,
};

describe('invokeProbe deep (streaming + tool-call) check', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    delete process.env.GANTRY_ONBOARDING_STRICT_MODEL_PROBE;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    delete process.env.GANTRY_ONBOARDING_STRICT_MODEL_PROBE;
  });

  it('passes when the model streams and calls the requested tool', async () => {
    fetchSpy.mockResolvedValue(sseResponse(200, TOOL_CALL_LINES));

    await expect(
      invokeProbe({ ...baseInput, entry: toolCapableEntry() }),
    ).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('never forces tool_choice to a specific function (OpenAI reasoning models reject that combined with streaming)', async () => {
    fetchSpy.mockResolvedValue(sseResponse(200, TOOL_CALL_LINES));

    await invokeProbe({ ...baseInput, entry: toolCapableEntry() });

    const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(requestInit.body as string);
    expect(sentBody.tool_choice).toBe('auto');
  });

  it('posts to /v1/chat/completions (not bare /chat/completions) for the native openai route', async () => {
    fetchSpy.mockResolvedValue(sseResponse(200, TOOL_CALL_LINES));

    await invokeProbe({
      ...baseInput,
      entry: toolCapableEntry(
        {},
        {
          id: 'openai',
          label: 'OpenAI',
          providerModelId: 'gpt-5.6-luna',
        },
      ),
    });

    const [requestUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(`${baseInput.baseUrl}/v1/chat/completions`);
  });

  it('posts to bare /chat/completions for non-openai routes (gateway prefix already carries /v1)', async () => {
    fetchSpy.mockResolvedValue(sseResponse(200, TOOL_CALL_LINES));

    await invokeProbe({ ...baseInput, entry: toolCapableEntry() });

    const [requestUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(`${baseInput.baseUrl}/chat/completions`);
  });

  it('soft-fails (warns, does not throw) when the tool is never called and strict mode is off', async () => {
    fetchSpy.mockResolvedValue(sseResponse(200, NO_TOOL_CALL_LINES));

    await expect(
      invokeProbe({ ...baseInput, entry: toolCapableEntry() }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'never called the requested tool',
    );
  });

  it('hard-fails when the tool is never called and strict mode is on', async () => {
    process.env.GANTRY_ONBOARDING_STRICT_MODEL_PROBE = '1';
    fetchSpy.mockResolvedValue(sseResponse(200, NO_TOOL_CALL_LINES));

    await expect(
      invokeProbe({ ...baseInput, entry: toolCapableEntry() }),
    ).rejects.toThrow('never called the requested tool');
  });

  it('always fails when the stream produces no output, regardless of strict mode', async () => {
    fetchSpy.mockResolvedValue(sseResponse(200, ['data: [DONE]\n\n']));

    await expect(
      invokeProbe({ ...baseInput, entry: toolCapableEntry() }),
    ).rejects.toThrow('produced no output');
  });

  it('retries once on a transient network failure before giving up', async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(sseResponse(200, TOOL_CALL_LINES));

    await expect(
      invokeProbe({ ...baseInput, entry: toolCapableEntry() }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('includes the real upstream error message on a non-401 failure', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'Unsupported parameter: tool_choice',
            type: 'invalid_request_error',
          },
        }),
        { status: 400 },
      ),
    );

    await expect(
      invokeProbe({ ...baseInput, entry: toolCapableEntry() }),
    ).rejects.toThrow('Unsupported parameter: tool_choice');
  });

  it("includes the real error message from Gantry's own gateway (flat error shape), not just OpenAI's nested shape", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Invalid model gateway request',
          message: 'Model gateway request path escaped provider prefix.',
        }),
        { status: 400 },
      ),
    );

    await expect(
      invokeProbe({ ...baseInput, entry: toolCapableEntry() }),
    ).rejects.toThrow('Model gateway request path escaped provider prefix.');
  });

  it('rejects credentials on a 401 upstream response', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(
      invokeProbe({ ...baseInput, entry: toolCapableEntry() }),
    ).rejects.toThrow('rejected the credentials');
  });
});

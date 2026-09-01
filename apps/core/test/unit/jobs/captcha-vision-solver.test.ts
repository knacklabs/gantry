import { afterEach, describe, expect, it, vi } from 'vitest';

import { solveCaptchaVision } from '@core/jobs/captcha-vision-solver.js';
import {
  configureCustomModelCatalogEntries,
  executableModelEntry,
  providerRoute,
} from '@core/shared/model-catalog.js';

const alias = 'gantry.browser.captcha.solve';

function configureSolver(
  provider: 'gemini' | 'openai' | 'anthropic',
  model: string,
) {
  configureCustomModelCatalogEntries([
    executableModelEntry({
      id: `settings:${alias}`,
      route: providerRoute(provider, model),
      displayName: 'Website recipe CAPTCHA solver',
      runnerModel: model,
      aliases: [alias],
      recommendedAlias: alias,
      source: { label: 'test', verifiedAt: '2026-08-25' },
      cacheMode: 'none',
      cacheTokenFields: [],
      supportsTools: true,
      supportedWorkloads: ['chat'],
    }),
  ]);
}

describe('CAPTCHA vision solver', () => {
  afterEach(() => configureCustomModelCatalogEntries([]));

  it('returns a consensus typed reading and revokes the gateway lease', async () => {
    configureSolver('gemini', 'gemini-3.1-flash-lite');
    const revoke = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"solved":true,"answer":"A7z9"}' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      solveCaptchaVision(
        {
          appId: 'app-test',
          imageBase64: 'aW1hZ2U=',
          mimeType: 'image/png',
          pageUrl: 'https://tenders.test/list',
        },
        {
          fetchImpl: fetchImpl as typeof fetch,
          acquireGateway: vi.fn(async () => ({
            injection: {
              env: {
                OPENAI_BASE_URL: 'http://127.0.0.1:9999/gemini',
                OPENAI_API_KEY: 'gtw_test',
              },
            },
            revoke,
          })) as never,
        },
      ),
    ).resolves.toEqual({ solved: true, answer: 'A7z9' });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/gemini/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('uses the Responses vision contract for an OpenAI route', async () => {
    configureSolver('openai', 'gpt-5.6-sol');
    const revoke = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ output_text: '{"solved":true,"answer":"K4p7"}' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      solveCaptchaVision(
        { appId: 'app-test', imageBase64: 'aW1hZ2U=', mimeType: 'image/png' },
        {
          fetchImpl: fetchImpl as typeof fetch,
          acquireGateway: vi.fn(async () => ({
            injection: {
              env: {
                OPENAI_BASE_URL: 'http://127.0.0.1:9999/openai',
                OPENAI_API_KEY: 'gtw_test',
              },
            },
            revoke,
          })) as never,
        },
      ),
    ).resolves.toEqual({ solved: true, answer: 'K4p7' });

    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      reasoning: { effort: string };
      max_output_tokens: number;
      text: { verbosity: string };
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/openai/v1/responses',
      expect.objectContaining({ method: 'POST', body: expect.any(String) }),
    );
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.max_output_tokens).toBe(128);
    expect(body.text.verbosity).toBe('low');
    expect(body.input[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'input_text' }),
        expect.objectContaining({ type: 'input_image', detail: 'original' }),
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('uses native Anthropic Messages vision for an Anthropic route', async () => {
    configureSolver('anthropic', 'claude-sonnet-4-6');
    const revoke = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'tool_use',
                name: 'captcha_result',
                input: { solved: true, answer: 'K4p7' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      solveCaptchaVision(
        { appId: 'app-test', imageBase64: 'aW1hZ2U=', mimeType: 'image/png' },
        {
          fetchImpl: fetchImpl as typeof fetch,
          acquireGateway: vi.fn(async () => ({
            injection: {
              env: {
                ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999/anthropic',
                ANTHROPIC_API_KEY: 'gtw_test',
              },
            },
            revoke,
          })) as never,
        },
      ),
    ).resolves.toEqual({ solved: true, answer: 'K4p7' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/anthropic/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'anthropic-version': '2023-06-01' }),
        body: expect.stringMatching(
          /"type":"image".*"tool_choice".*"captcha_result"/su,
        ),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('rejects an invalid typed response without trying another route', async () => {
    configureSolver('openai', 'gpt-5.6-sol');
    const revoke = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: '{"solved":true,"answer":"not valid!"}',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      solveCaptchaVision(
        { appId: 'app-test', imageBase64: 'aW1hZ2U=', mimeType: 'image/png' },
        {
          fetchImpl: fetchImpl as typeof fetch,
          acquireGateway: vi.fn(async () => ({
            injection: {
              env: {
                OPENAI_BASE_URL: 'http://127.0.0.1:9999/openai',
                OPENAI_API_KEY: 'gtw_test',
              },
            },
            revoke,
          })) as never,
        },
      ),
    ).resolves.toEqual({ solved: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('adjudicates disagreeing readings without accepting a new candidate', async () => {
    configureSolver('openai', 'gpt-5.6-sol');
    const revoke = vi.fn();
    const answers = ['A7z9', 'A7Z9', 'A729', 'A7z9'];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              solved: true,
              answer: answers.shift(),
            }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      solveCaptchaVision(
        { appId: 'app-test', imageBase64: 'aW1hZ2U=', mimeType: 'image/png' },
        {
          fetchImpl: fetchImpl as typeof fetch,
          acquireGateway: vi.fn(async () => ({
            injection: {
              env: {
                OPENAI_BASE_URL: 'http://127.0.0.1:9999/openai',
                OPENAI_API_KEY: 'gtw_test',
              },
            },
            revoke,
          })) as never,
        },
      ),
    ).resolves.toEqual({ solved: true, answer: 'A7z9' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const adjudicationRequest = JSON.parse(
      String((fetchImpl.mock.calls[3]?.[1] as RequestInit).body),
    ) as { input: Array<{ content: Array<{ text?: string }> }> };
    expect(adjudicationRequest.input[0]?.content[0]?.text).toContain(
      'independent candidate transcriptions ["A7z9","A7Z9","A729"]',
    );
    expect(revoke).toHaveBeenCalledOnce();
  });
});

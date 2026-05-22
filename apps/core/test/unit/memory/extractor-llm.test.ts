import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArcExtractionInput } from '@core/memory/extractor-types.js';

const memoryQueryMock = vi.hoisted(() => vi.fn());
const memoryIsConfiguredMock = vi.hoisted(() => vi.fn());

vi.mock('@core/memory/memory-llm-port.js', () => ({
  getMemoryLlmClient: () => ({
    isConfigured: memoryIsConfiguredMock,
    query: memoryQueryMock,
  }),
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '@core/infrastructure/logging/logger.js';

let runtimeRoot = '';

function writeCredentialSettings(
  mode: 'none' | 'onecli' | 'external',
  memoryExtractorModel?: string,
): void {
  fs.writeFileSync(
    path.join(runtimeRoot, 'settings.yaml'),
    [
      'providers: {}',
      'storage:',
      '  postgres:',
      '    url_env: GANTRY_DATABASE_URL',
      '    schema: gantry',
      'credential_broker:',
      `  mode: ${mode}`,
      '  onecli:',
      '    url: http://localhost:10254',
      '  external:',
      '    base_url: ""',
      'memory:',
      '  enabled: true',
      '  embeddings:',
      '    enabled: false',
      '    provider: disabled',
      '    model: text-embedding-3-large',
      '  dreaming:',
      '    enabled: false',
      ...(memoryExtractorModel
        ? [
            '  llm:',
            '    models:',
            `      extractor: ${memoryExtractorModel}`,
            '      dreaming: sonnet',
            '      consolidation: sonnet',
          ]
        : []),
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function createProvider() {
  const { LlmMemoryExtractionProvider } =
    await import('@core/memory/extractor-llm.js');
  return new LlmMemoryExtractionProvider();
}

function configureMemoryQueryMock(): void {
  memoryIsConfiguredMock.mockReturnValue(true);
  memoryQueryMock.mockImplementation(async (opts: { model?: string }) => {
    const response = await globalThis.fetch('https://memory-llm.local/mock', {
      method: 'POST',
      headers: opts.model ? { 'x-gantry-model': opts.model } : undefined,
    });
    const json = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    return json.content?.find((entry) => entry.type === 'text')?.text ?? '';
  });
}

beforeEach(() => {
  vi.resetModules();
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-extractor-llm-'));
  writeCredentialSettings('onecli');
  vi.stubEnv('GANTRY_HOME', runtimeRoot);
  memoryIsConfiguredMock.mockReturnValue(true);
});

afterEach(() => {
  if (runtimeRoot) {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    runtimeRoot = '';
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  memoryQueryMock.mockReset();
  memoryIsConfiguredMock.mockReset();
});

describe('LlmMemoryExtractionProvider', () => {
  it('uses broker-safe OneCLI env when extraction is enabled', async () => {
    configureMemoryQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  scope: 'group',
                  kind: 'fact',
                  key: 'deploy-policy',
                  value: 'Use npm test before deploy.',
                  why: 'Team decision: use npm test before deploy.',
                  confidence: 0.91,
                },
              ]),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = await createProvider();
    const input: ArcExtractionInput = {
      turns: [
        { role: 'user', text: 'Team decision: use npm test before deploy.' },
        {
          role: 'assistant',
          text: 'We will use npm test before every deploy.',
        },
      ],
      trigger: 'session-end',
      retrievedItems: [],
    };

    const facts = await provider.extractFacts(input);
    expect(facts).toEqual([
      {
        scope: 'group',
        kind: 'fact',
        key: 'deploy-policy',
        value: 'Use npm test before deploy.',
        why: 'Team decision: use npm test before deploy.',
        confidence: 0.91,
      },
    ]);

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(requestInit?.headers as HeadersInit);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://memory-llm.local/mock');
    expect(headers.get('x-gantry-model')).toBe('claude-haiku-4-5-20251001');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    expect(memoryQueryMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('reads the current memory model setting for the next extraction call', async () => {
    configureMemoryQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: '[]' }] }),
        ),
    );

    const provider = await createProvider();
    const input: ArcExtractionInput = {
      turns: [{ role: 'user', text: 'Remember that Kimi handles memory.' }],
      trigger: 'session-end',
      retrievedItems: [],
    };

    await provider.extractFacts(input);
    writeCredentialSettings('onecli', 'kimi');
    await provider.extractFacts(input);

    expect(memoryQueryMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
    });
    expect(memoryQueryMock.mock.calls[1]?.[0]).toMatchObject({
      model: 'moonshotai/kimi-k2.6',
    });
  });

  it('does not pre-filter non-keyword turns before LLM extraction', async () => {
    configureMemoryQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '[]' }],
          }),
          { status: 200 },
        ),
    );

    const provider = await createProvider();
    const facts = await provider.extractFacts({
      turns: [
        { role: 'user', text: 'Check again please.' },
        { role: 'assistant', text: 'Done.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(facts).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await expect(
      provider.extractFactsWithOutcome({
        turns: [
          { role: 'user', text: 'Check again please.' },
          { role: 'assistant', text: 'Done.' },
        ],
        trigger: 'precompact',
        retrievedItems: [],
      }),
    ).resolves.toMatchObject({
      facts: [],
      status: 'empty_qualified',
      zeroFactReason: 'no_qualifying_facts',
    });
  });

  it('runs LLM extraction for role assignment facts like CTO', async () => {
    configureMemoryQueryMock();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  scope: 'group',
                  kind: 'fact',
                  key: 'fact:cto',
                  value: 'CTO is Kartik Bansal.',
                  why: 'My CTO is Kartik Bansal.',
                  confidence: 0.9,
                },
              ]),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = await createProvider();
    const facts = await provider.extractFacts({
      turns: [
        { role: 'user', text: 'My CTO is Kartik Bansal.' },
        { role: 'assistant', text: 'Noted, I will remember that.' },
      ],
      trigger: 'session-end',
      retrievedItems: [],
    });

    expect(facts).toEqual([
      {
        scope: 'group',
        kind: 'fact',
        key: 'fact:cto',
        value: 'CTO is Kartik Bansal.',
        why: 'My CTO is Kartik Bansal.',
        confidence: 0.9,
      },
    ]);
  });

  it('redacts sensitive retrieved items before building outbound LLM prompt', async () => {
    configureMemoryQueryMock();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[]' }],
        }),
        { status: 200 },
      ),
    );

    const provider = await createProvider();
    await provider.extractFacts({
      turns: [
        {
          role: 'user',
          text: 'Temporary key is sk-ant-abcdefghijklmnopqrstuvwxyz123456',
        },
        { role: 'assistant', text: 'Noted.' },
      ],
      trigger: 'precompact',
      retrievedItems: [
        {
          id: 'mem-1',
          key: 'auth:github_pat_abcd1234abcd1234abcd1234',
          value:
            'token=github_pat_abcd1234abcd1234abcd1234 and aws=AKIA1234567890ABCDEF',
        },
      ],
    });

    expect(memoryQueryMock).toHaveBeenCalled();
    const queryArg = memoryQueryMock.mock.calls[0]?.[0] as
      | { prompt?: string }
      | undefined;
    const prompt = queryArg?.prompt || '';
    expect(prompt).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz123456');
    expect(prompt).not.toContain('github_pat_abcd1234abcd1234abcd1234');
    expect(prompt).not.toContain('AKIA1234567890ABCDEF');
    expect(prompt).toContain('[REDACTED_SECRET]');
  });

  it('blocks outbound extraction when transcript contains uncertain secret-like material', async () => {
    configureMemoryQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[]' }],
        }),
        { status: 200 },
      ),
    );

    const provider = await createProvider();
    const result = await provider.extractFactsWithOutcome({
      turns: [
        {
          role: 'user',
          text: 'credential blob q8N7_w9QfLh2Zr3Xy6Tt5Uv4sPd1Km0Qe9Jw2Nb7Hx3Y',
        },
        { role: 'assistant', text: 'Noted.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(result).toMatchObject({
      facts: [],
      status: 'sensitive_blocked',
      zeroFactReason: 'sensitive_blocked',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.any(String),
        trigger: 'precompact',
        reason: expect.any(String),
      }),
      'LLM extraction blocked due to potential sensitive transcript material',
    );
  });

  it('retries once on transient extractor failures', async () => {
    configureMemoryQueryMock();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: JSON.stringify([
                  {
                    scope: 'group',
                    kind: 'fact',
                    key: 'fact:retry-ok',
                    value: 'Retry recovered extraction.',
                    why: 'Retry recovered extraction.',
                    confidence: 0.9,
                  },
                ]),
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const provider = await createProvider();
    const facts = await provider.extractFacts({
      turns: [
        { role: 'user', text: 'Retry recovered extraction.' },
        { role: 'assistant', text: 'Noted.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(facts).toEqual([
      {
        scope: 'group',
        kind: 'fact',
        key: 'fact:retry-ok',
        value: 'Retry recovered extraction.',
        why: 'Retry recovered extraction.',
        confidence: 0.9,
      },
    ]);
  });

  it('logs LLM extraction failures and skips extraction when auth is configured', async () => {
    configureMemoryQueryMock();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('oauth request rejected'),
    );

    const provider = await createProvider();
    const result = await provider.extractFactsWithOutcome({
      turns: [
        { role: 'user', text: 'Team decision: use npm test before deploy.' },
        { role: 'assistant', text: 'Decision recorded.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(result).toMatchObject({
      facts: [],
      status: 'extractor_failed',
      zeroFactReason: 'extractor_failed',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        model: expect.any(String),
      }),
      'LLM extraction failed; skipping this boundary extraction',
    );
  });

  it.each([
    ['empty text', ''],
    ['malformed JSON', '[{"kind": "fact"'],
    ['non-array JSON', '{"kind": "fact"}'],
  ])('classifies %s extractor output as a failure', async (_name, text) => {
    configureMemoryQueryMock();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
        }),
        { status: 200 },
      ),
    );

    const provider = await createProvider();
    const result = await provider.extractFactsWithOutcome({
      turns: [
        { role: 'user', text: 'Team decision: use npm test before deploy.' },
        { role: 'assistant', text: 'Decision recorded.' },
      ],
      trigger: 'precompact',
      retrievedItems: [],
    });

    expect(result).toMatchObject({
      facts: [],
      status: 'extractor_failed',
      zeroFactReason: 'extractor_failed',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.any(String),
        trigger: 'precompact',
      }),
      'LLM extraction returned malformed output; skipping this boundary extraction',
    );
  });

  it('skips extraction when the memory LLM client is unavailable', async () => {
    writeCredentialSettings('none');
    memoryIsConfiguredMock.mockReturnValue(false);
    vi.resetModules();
    const provider = await createProvider();

    const result = await provider.extractFactsWithOutcome({
      turns: [
        { role: 'user', text: 'Team decision: use npm test before deploy.' },
        { role: 'assistant', text: 'Decision recorded.' },
      ],
      trigger: 'session-end',
      retrievedItems: [],
    });

    expect(result).toMatchObject({
      facts: [],
      status: 'auth_unavailable',
      zeroFactReason: 'auth_unavailable',
    });
    expect(memoryQueryMock).not.toHaveBeenCalled();
  });
});

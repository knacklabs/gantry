import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryExtractionInput } from '@core/memory/memory-extractor.js';
import { LlmMemoryExtractionProvider } from '@core/memory/extractor-llm.js';

const claudeQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeQueryMock,
}));

vi.mock('@core/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '@core/core/logger.js';

function configureClaudeQueryMock(): void {
  claudeQueryMock.mockImplementation(async function* () {
    const headers: HeadersInit = {};
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (oauthToken) {
      headers.authorization = `Bearer ${oauthToken}`;
    }
    const response = await globalThis.fetch('https://claude.local/mock', {
      method: 'POST',
      headers,
    });
    const json = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = json.content?.find((entry) => entry.type === 'text')?.text;
    yield {
      type: 'assistant',
      message: {
        content: text ? [{ type: 'text', text }] : [],
      },
    };
  });
}

beforeEach(() => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  claudeQueryMock.mockReset();
});

describe('LlmMemoryExtractionProvider', () => {
  it('uses OAuth authToken when CLAUDE_CODE_OAUTH_TOKEN is set', async () => {
    configureClaudeQueryMock();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-extractor-token');
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
                  confidence: 0.91,
                },
              ]),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new LlmMemoryExtractionProvider();
    const input: MemoryExtractionInput = {
      prompt: 'Team decision: use npm test before deploy.',
      result: 'We will use npm test before every deploy.',
      retrievedItems: [],
    };

    const facts = await provider.extractFacts(input);
    expect(facts).toEqual([
      {
        scope: 'group',
        kind: 'fact',
        key: 'deploy-policy',
        value: 'Use npm test before deploy.',
        confidence: 0.91,
      },
    ]);

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(requestInit?.headers as HeadersInit);
    expect(headers.get('authorization')).toBe('Bearer oauth-extractor-token');
    expect(headers.get('x-api-key')).toBeNull();
  });

  it('does not pre-filter non-keyword turns before LLM extraction', async () => {
    configureClaudeQueryMock();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-extractor-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[]' }],
        }),
        { status: 200 },
      ),
    );

    const provider = new LlmMemoryExtractionProvider();
    const facts = await provider.extractFacts({
      prompt: 'Check again please.',
      result: 'Done.',
      retrievedItems: [],
    });

    expect(facts).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('runs LLM extraction for role assignment facts like CTO', async () => {
    configureClaudeQueryMock();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-extractor-token');
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
                  confidence: 0.9,
                },
              ]),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new LlmMemoryExtractionProvider();
    const facts = await provider.extractFacts({
      prompt: 'My CTO is Kartik Bansal.',
      result: 'Noted, I will remember that.',
      retrievedItems: [],
    });

    expect(facts).toEqual([
      {
        scope: 'group',
        kind: 'fact',
        key: 'fact:cto',
        value: 'CTO is Kartik Bansal.',
        confidence: 0.9,
      },
    ]);
  });

  it('logs LLM extraction failures and skips extraction when auth is configured', async () => {
    configureClaudeQueryMock();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-extractor-token');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('oauth request rejected'),
    );

    const provider = new LlmMemoryExtractionProvider();
    const facts = await provider.extractFacts({
      prompt: 'Team decision: use npm test before deploy.',
      result: 'Decision recorded.',
      retrievedItems: [],
    });

    expect(facts).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        model: expect.any(String),
      }),
      'LLM extraction failed; skipping this turn',
    );
  });

  it('skips extraction when Claude auth is unavailable', async () => {
    const provider = new LlmMemoryExtractionProvider();

    const facts = await provider.extractFacts({
      prompt: 'Team decision: use npm test before deploy.',
      result: 'Decision recorded.',
      retrievedItems: [],
    });

    expect(facts).toEqual([]);
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });
});

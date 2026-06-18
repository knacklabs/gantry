import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerMemoryLlmClient } from '@core/memory/memory-llm-port.js';
import { createRouteAwareMemoryLlmClient } from '@core/adapters/llm/route-aware-memory-llm-client.js';
import type {
  MemoryLlmClient,
  MemoryLlmModelProfile,
  MemoryLlmQueryOpts,
} from '@core/domain/ports/memory-llm-client.js';

/**
 * End-to-end memory extraction over an OpenAI-family model profile. The
 * extractor resolves an OpenAI-family memory profile from config and dispatches
 * through the route-aware client, which must hand the query to the OpenAI lane
 * and parse its facts JSON exactly as it does for the default family.
 */
const OPENAI_EXTRACTOR_PROFILE: MemoryLlmModelProfile = {
  alias: 'gpt',
  runnerModel: 'gpt-test',
  responseFamily: 'openai',
  modelRoute: 'openai',
  modelRouteLabel: 'OpenAI',
  displayName: 'GPT Test',
};

const getMemoryModelRuntimeConfigMock = vi.hoisted(() => vi.fn());

vi.mock('@core/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getMemoryModelRuntimeConfig: getMemoryModelRuntimeConfigMock,
  };
});

beforeEach(() => {
  getMemoryModelRuntimeConfigMock.mockReturnValue({
    extractor: 'gpt-test',
    dreaming: 'gpt-test',
    consolidation: 'gpt-test',
    modelProfiles: {
      extractor: OPENAI_EXTRACTOR_PROFILE,
      dreaming: OPENAI_EXTRACTOR_PROFILE,
      consolidation: OPENAI_EXTRACTOR_PROFILE,
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

function jsonFactsClient(
  seen: MemoryLlmQueryOpts[],
  factsJson: string,
): MemoryLlmClient {
  return {
    isConfigured: () => true,
    query: async (opts) => {
      seen.push(opts);
      return factsJson;
    },
  };
}

describe('memory extraction over an OpenAI-family route', () => {
  it('extracts facts produced by the OpenAI lane via the route-aware client', async () => {
    const { LlmMemoryExtractionProvider } =
      await import('@core/memory/extractor-llm.js');

    const openaiSeen: MemoryLlmQueryOpts[] = [];
    const defaultSeen: MemoryLlmQueryOpts[] = [];

    const factsJson = JSON.stringify([
      {
        kind: 'preference',
        scope: 'group',
        key: 'preferred report format',
        value: 'The user prefers weekly reports delivered as a PDF summary.',
        confidence: 0.95,
        why: 'I want the weekly report as a PDF summary going forward',
      },
    ]);

    registerMemoryLlmClient(
      createRouteAwareMemoryLlmClient({
        anthropic: jsonFactsClient(defaultSeen, '[]'),
        // OpenAI-family memory dispatches to the OpenAI direct client.
        openai: jsonFactsClient(openaiSeen, factsJson),
      }),
    );

    const result =
      await new LlmMemoryExtractionProvider().extractFactsWithOutcome({
        appId: 'default' as never,
        trigger: 'session-end',
        userId: 'user-1',
        turns: [
          {
            role: 'user',
            text: 'I want the weekly report as a PDF summary going forward, not a spreadsheet.',
          },
          {
            role: 'assistant',
            text: 'Understood, I will send the weekly report as a PDF summary.',
          },
        ],
      });

    // The OpenAI lane (not the default lane) was selected by response family.
    expect(openaiSeen).toHaveLength(1);
    expect(defaultSeen).toHaveLength(0);
    expect(openaiSeen[0]?.modelProfile).toEqual(OPENAI_EXTRACTOR_PROFILE);
    expect(openaiSeen[0]?.userBlocks?.some((block) => block.cacheStatic)).toBe(
      true,
    );

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      kind: 'preference',
      scope: 'group',
      value: 'The user prefers weekly reports delivered as a PDF summary.',
    });
  });
});

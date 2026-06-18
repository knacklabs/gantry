import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETUP_MODEL_ALIAS,
  findModelByRunnerModel,
  listModelCatalogEntries,
  MEMORY_MODEL_DEFAULT_ALIASES,
  resolveModelSelection,
  resolveModelSelectionForWorkload,
  resolveRunnerModel,
} from '@core/shared/model-catalog.js';
import { resolveModelCacheSupport } from '@core/shared/model-cache-support.js';
import {
  formatContextWindow,
  formatCostPerMillion,
  formatModelCatalog,
} from '@core/shared/model-catalog-format.js';
import { normalizeModelUsage } from '@core/shared/model-usage.js';

function rowFor(text: string, alias: string): string {
  const line = text.split('\n').find((row) => row.startsWith(`${alias} |`));
  if (!line) throw new Error(`row for ${alias} not found`);
  return line;
}

describe('model catalog resolution', () => {
  it('keeps versioned aliases pinned while short aliases stay recommended', () => {
    expect(resolveModelSelection(' kimi 2.6 ')).toMatchObject({
      ok: true,
      alias: 'kimi-2.6',
      runnerModel: 'moonshotai/kimi-k2.6',
    });
    expect(resolveModelSelection('kimi')).toMatchObject({
      ok: true,
      alias: 'kimi',
      runnerModel: 'moonshotai/kimi-k2.6',
    });
    expect(resolveModelSelection('Opus 4.8')).toMatchObject({
      ok: true,
      alias: 'opus-4.8',
    });
  });

  it('finds catalog entries by runner or provider model IDs for runtime accounting', () => {
    expect(resolveModelSelection('openrouter:kimi-k2.6')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
    expect(findModelByRunnerModel('moonshotai/kimi-k2.6')).toMatchObject({
      recommendedAlias: 'kimi',
    });
  });

  it('resolves OpenAI chat aliases on the openai response family', () => {
    expect(resolveModelSelection('gpt')).toMatchObject({
      ok: true,
      alias: 'gpt',
      runnerModel: 'gpt-5.5',
    });
    expect(resolveModelSelection('gpt-mini')).toMatchObject({
      ok: true,
      alias: 'gpt-mini',
      runnerModel: 'gpt-5.4-mini',
    });
    expect(findModelByRunnerModel('gpt-5.5')?.responseFamily).toBe('openai');
  });

  it('resolves Bedrock and Vertex aliases through the DeepAgents lane', () => {
    expect(resolveModelSelection('bedrock-oss')).toMatchObject({
      ok: true,
      alias: 'bedrock-oss',
      runnerModel: 'openai.gpt-oss-120b-1:0',
      entry: {
        responseFamily: 'openai',
        modelRoute: { id: 'bedrock' },
      },
    });
    expect(resolveModelSelection('vertex')).toMatchObject({
      ok: true,
      alias: 'vertex',
      runnerModel: 'google/gemini-3.5-flash',
      entry: {
        responseFamily: 'openai',
        modelRoute: { id: 'vertex' },
      },
    });
    expect(resolveModelSelection('bedrock-sonnet')).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
  });

  it('keeps Bedrock Anthropic models out of the OpenAI-compatible catalog', () => {
    const bedrockEntries = listModelCatalogEntries().filter(
      (entry) => entry.modelRoute.id === 'bedrock',
    );
    expect(bedrockEntries).not.toHaveLength(0);
    expect(
      bedrockEntries.map((entry) => entry.modelRoute.providerModelId),
    ).not.toContain('us.anthropic.claude-sonnet-4-6');
  });

  it('scopes OpenAI chat models to chat and memory workloads, not jobs', () => {
    expect(resolveModelSelectionForWorkload('gpt', 'chat')).toMatchObject({
      ok: true,
      alias: 'gpt',
    });
    // OpenAI gpt entries now declare the memory workloads so a zero-Anthropic
    // deployment can select them for memory under the deepagents memory engine.
    for (const workload of [
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ] as const) {
      expect(resolveModelSelectionForWorkload('gpt', workload)).toMatchObject({
        ok: true,
        alias: 'gpt',
      });
      expect(
        resolveModelSelectionForWorkload('gpt-mini', workload),
      ).toMatchObject({ ok: true, alias: 'gpt-mini' });
    }
    // Jobs remain out of scope for OpenAI-lane chat models.
    expect(
      resolveModelSelectionForWorkload('gpt', 'one_time_job'),
    ).toMatchObject({
      ok: false,
      reason: 'unsupported-workload',
    });
  });

  it('uses catalog aliases for setup and memory defaults', () => {
    expect(DEFAULT_SETUP_MODEL_ALIAS).toBe('opus');
    expect(MEMORY_MODEL_DEFAULT_ALIASES).toEqual({
      extractor: 'haiku',
      dreaming: 'sonnet',
      consolidation: 'sonnet',
    });
  });

  it('resolves catalog aliases without accepting raw runner IDs', () => {
    expect(resolveRunnerModel('opus')).toBe('claude-opus-4-8');
    expect(resolveRunnerModel('opus 4.8')).toBe('claude-opus-4-8');
    expect(resolveRunnerModel('opus 4.7')).toBe('claude-opus-4-7');
    expect(resolveRunnerModel('claude-sonnet-4-6')).toBeUndefined();
    expect(resolveRunnerModel('opusplan')).toBeUndefined();
    expect(resolveRunnerModel('best')).toBeUndefined();
  });

  it('rejects raw provider model IDs from user-facing alias resolution', () => {
    expect(resolveModelSelection('claude-opus-4-7')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
    expect(resolveModelSelection('claude-ambient-model')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
  });

  it('rejects raw provider model IDs with actionable guidance', () => {
    expect(resolveModelSelection('moonshotai/kimi-k2.6')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
    expect(
      resolveModelSelection('us.anthropic.claude-sonnet-4-6'),
    ).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
    expect(resolveModelSelection('google/gemini-3.5-flash')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
    expect(resolveModelSelection('openai.gpt-oss-120b')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
  });

  it('enforces workload eligibility for catalog aliases', () => {
    expect(resolveModelSelectionForWorkload('opus', 'chat')).toMatchObject({
      ok: true,
      alias: 'opus',
    });
    expect(
      resolveModelSelectionForWorkload('opus', 'memory_extractor'),
    ).toMatchObject({
      ok: false,
      reason: 'unsupported-workload',
    });
    expect(
      resolveModelSelectionForWorkload('kimi', 'memory_consolidation'),
    ).toMatchObject({
      ok: true,
      alias: 'kimi',
    });
  });

  it('suggests close aliases for typos', () => {
    expect(resolveModelSelection('sonet')).toMatchObject({
      ok: false,
      reason: 'unknown',
      suggestion: 'sonnet',
    });
  });

  it('renders model catalog defaults across chat and scheduler lanes', () => {
    const output = formatModelCatalog({
      defaults: {
        chat: 'opus',
        oneTime: 'sonnet',
        recurring: 'kimi',
        memoryExtractor: 'haiku',
        memoryDreaming: 'sonnet',
        memoryConsolidation: 'sonnet',
      },
    });

    expect(output).toContain('Supported model aliases');
    expect(output).toContain('Response family');
    expect(output).toContain('prompt cache supported/accounted');
    expect(output).toContain('chat default');
    expect(output).toContain('one-time default');
    expect(output).toContain('recurring default');
    expect(output).toContain('memory extractor');
    expect(output).toContain('OpenRouter');
    // Model families section: provider auto-selected by configured key.
    expect(output).toContain(
      'Model families (provider auto-selected by configured key)',
    );
    expect(output).toContain('gpt-oss | GPT-OSS 120B | groq-oss > cerebras');
    expect(output).toContain('llama-70b | Llama 3.3 70B | groq > together');
  });

  it('declares curated context windows for empty-profile deepagents models', () => {
    // These ids have no built-in LangChain profile, so the catalog is the source
    // of truth for the compaction window + context-usage reporting.
    const curated: Array<[string, number]> = [
      ['gemini-2.5-pro', 1_048_576],
      ['gemini-2.5-flash', 1_048_576],
      ['gemini-3.5-flash', 1_048_576],
      ['llama-3.3-70b-versatile', 131_072],
      ['llama-3.1-8b-instant', 131_072],
      ['openai/gpt-oss-120b', 131_072],
      ['deepseek-v4-pro', 1_048_576],
      ['grok-4.3', 256_000],
      ['grok-build-0.1', 256_000],
      ['Qwen/Qwen3-235B-A22B-fp8-tput', 40_960],
      ['accounts/fireworks/models/deepseek-v3p1', 163_840],
      ['gpt-oss-120b', 131_072],
      ['zai-glm-4.7', 131_072],
      ['sonar-pro', 200_000],
      ['sonar', 131_072],
      ['gpt-5.4-mini', 400_000],
      ['moonshotai/kimi-k2.6', 262_142],
    ];
    for (const [runnerModel, window] of curated) {
      const entry = findModelByRunnerModel(runnerModel);
      expect(entry, runnerModel).toBeDefined();
      expect(entry?.contextWindowTokens, runnerModel).toBe(window);
    }
  });

  it('omits contextWindowTokens for ids with a real library profile', () => {
    // gpt-5.5/gpt-5.4 have a real LangChain profile, so the factory must use it
    // (no curated override). The catalog must NOT declare a window for them.
    expect(
      findModelByRunnerModel('gpt-5.5')?.contextWindowTokens,
    ).toBeUndefined();
    expect(
      findModelByRunnerModel('gpt-5.4')?.contextWindowTokens,
    ).toBeUndefined();
  });

  it('renders a context-window column in the model catalog table', () => {
    const output = formatModelCatalog({ defaults: { chat: 'opus' } });
    // Header carries the Context + Cost columns; Gemini Pro shows the 1M window.
    expect(output).toContain(
      'Alias | Model | Response family | Route | Context | Cache | Cost (in/out per 1M) | Status',
    );
    expect(output).toMatch(/gemini \| Gemini 2\.5 Pro \|[^\n]*\| 1\.0M \|/);
    expect(output).toMatch(/groq \| Groq Llama 3\.3 70B[^\n]*\| 131K \|/);
  });

  it('formats per-1M cost with trimmed trailing zeros', () => {
    const groq = findModelByRunnerModel('llama-3.3-70b-versatile')!;
    expect(formatCostPerMillion(groq)).toBe('$0.59/$0.79');
    const gemini = findModelByRunnerModel('gemini-2.5-pro')!;
    expect(formatCostPerMillion(gemini)).toBe('$1.25/$10');
    // Omitted pricing renders as an em dash.
    const cerebras = findModelByRunnerModel('gpt-oss-120b')!;
    expect(formatCostPerMillion(cerebras)).toBe('—');
  });

  it('renders a Cost column with curated prices and "—" when omitted', () => {
    const output = formatModelCatalog();
    // Priced DeepAgents-lane providers show in/out per 1M.
    expect(rowFor(output, 'groq')).toContain('$0.59/$0.79');
    expect(rowFor(output, 'gemini')).toContain('$1.25/$10');
    expect(rowFor(output, 'grok')).toContain('$1.25/$2.5');
    // SDK-lane Anthropic alias carries its declared price too.
    expect(rowFor(output, 'opus')).toContain('$5/$25');
    // Omitted prices render as an em dash: Perplexity (hybrid per-request fee),
    // Cerebras (subscription-only), Fireworks DeepSeek v3p1 (unverifiable band).
    expect(rowFor(output, 'perplexity')).toContain('| — |');
    expect(rowFor(output, 'cerebras')).toContain('| — |');
    expect(rowFor(output, 'fireworks')).toContain('| — |');
  });

  it('derives cache support from provider metadata and model route', () => {
    const anthropic = findModelByRunnerModel('claude-sonnet-4-6');
    const openrouter = findModelByRunnerModel('moonshotai/kimi-k2.6');

    expect(anthropic && resolveModelCacheSupport(anthropic)).toMatchObject({
      providerId: 'anthropic',
      cacheProvider: 'anthropic',
      statusLabel: 'prompt cache supported/accounted',
      prompt: {
        mode: 'anthropic_cache_control',
        supported: true,
        accounted: true,
      },
      response: {
        mode: 'none',
        available: false,
      },
    });
    expect(openrouter && resolveModelCacheSupport(openrouter)).toMatchObject({
      providerId: 'openrouter',
      cacheProvider: 'openrouter-provider',
      statusLabel:
        'automatic provider cache; response cache available but disabled',
      prompt: {
        mode: 'openrouter_automatic_prefix',
        automatic: true,
        supported: true,
        accounted: true,
      },
      response: {
        mode: 'openrouter_response_cache',
        enabledByDefault: false,
        available: true,
      },
    });
  });
});

describe('model usage normalization', () => {
  it('normalizes Anthropic-style modelUsage payloads and cache accounting', () => {
    const usage = normalizeModelUsage({
      message: {
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
            costUSD: 0.002,
          },
        },
      },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(usage).toMatchObject({
      model: 'sonnet',
      responseFamily: 'anthropic',
      modelRoute: 'anthropic',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalBillableInputTokens: 60,
      estimatedCostUsd: 0.002,
      cacheProvider: 'anthropic',
      cacheStatus: 'partial',
    });
    expect(typeof usage?.at).toBe('string');
  });

  it('does not infer cache support for uncataloged modelUsage entries', () => {
    const usage = normalizeModelUsage({
      message: {
        modelUsage: {
          'future-model': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
          },
        },
      },
    });

    expect(usage).toMatchObject({
      model: 'future-model',
      cacheProvider: 'none',
      cacheStatus: 'unsupported',
    });
  });

  it('marks aggregate modelUsage from multiple models as mixed', () => {
    const usage = normalizeModelUsage({
      message: {
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
            costUSD: 0.002,
          },
          'moonshotai/kimi-k2.6': {
            inputTokens: 50,
            outputTokens: 10,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 0,
            costUSD: 0.001,
          },
        },
      },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(usage).toMatchObject({
      model: 'mixed',
      responseFamily: 'anthropic',
      modelRoute: undefined,
      provider: undefined,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      estimatedCostUsd: 0.003,
      cacheProvider: 'mixed',
      cacheStatus: 'partial',
    });
  });

  it('normalizes OpenRouter usage payload cache details', () => {
    const usage = normalizeModelUsage({
      message: {
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: {
            cached_tokens: 50,
            cache_write_tokens: 0,
          },
        },
      },
      fallbackModel: 'moonshotai/kimi-k2.6',
    });

    expect(usage).toMatchObject({
      model: 'kimi',
      responseFamily: 'anthropic',
      modelRoute: 'openrouter',
      provider: 'openrouter',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 70,
      cacheProvider: 'openrouter-provider',
      cacheStatus: 'hit',
    });
  });

  it('reads direct Anthropic cache usage fields from provider metadata', () => {
    const usage = normalizeModelUsage({
      message: {
        usage: {
          input_tokens: 200,
          output_tokens: 40,
          cache_read_input_tokens: 75,
          cache_creation_input_tokens: 25,
        },
      },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(usage).toMatchObject({
      model: 'sonnet',
      modelRoute: 'anthropic',
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 75,
      cacheWriteTokens: 25,
      totalBillableInputTokens: 125,
      cacheProvider: 'anthropic',
      cacheStatus: 'partial',
    });
  });

  it('estimates DeepAgents-lane cost from catalog price for the raw usage branch', () => {
    // gemini-2.5-pro: $1.25/1M input, $10/1M output. The chat-completions usage
    // shape carries no SDK cost, so the catalog price drives the estimate.
    // Cached reads are billed at the input price (not discounted), so the full
    // prompt_tokens count is charged at input.
    const usage = normalizeModelUsage({
      message: {
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 500_000,
          prompt_tokens_details: { cached_tokens: 400_000 },
        },
      },
      fallbackModel: 'gemini-2.5-pro',
    });
    // 1.0M input * $1.25 + 0.5M output * $10 = 1.25 + 5 = $6.25.
    expect(usage?.estimatedCostUsd).toBeCloseTo(6.25, 6);
    expect(usage?.inputTokens).toBe(1_000_000);
    expect(usage?.outputTokens).toBe(500_000);
  });

  it('leaves DeepAgents-lane cost undefined when the model has no curated price', () => {
    // cerebras gpt-oss-120b omits pricing (subscription-only) -> no estimate.
    const usage = normalizeModelUsage({
      message: {
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      },
      fallbackModel: 'gpt-oss-120b',
    });
    expect(usage?.estimatedCostUsd).toBeUndefined();
  });

  it('marks cache as unsupported when provider metadata is unavailable', () => {
    const usage = normalizeModelUsage({
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          prompt_tokens_details: {
            cached_tokens: 2,
          },
        },
      },
      fallbackModel: 'unknown-model',
    });

    expect(usage).toMatchObject({
      model: 'unknown-model',
      responseFamily: undefined,
      modelRoute: undefined,
      provider: undefined,
      cacheProvider: 'none',
      cacheStatus: 'unsupported',
      totalBillableInputTokens: 10,
    });
  });

  it('returns undefined when usage payload is absent', () => {
    expect(normalizeModelUsage({ message: {}, fallbackModel: 'sonnet' })).toBe(
      undefined,
    );
  });

  it('finds entries by runner ID, provider model ID, and alias', () => {
    expect(findModelByRunnerModel('claude-opus-4-8')?.recommendedAlias).toBe(
      'opus',
    );
    expect(findModelByRunnerModel('claude-opus-4-7')?.recommendedAlias).toBe(
      'opus-4.7',
    );
    expect(
      findModelByRunnerModel('moonshotai/kimi-k2.6')?.recommendedAlias,
    ).toBe('kimi');
    expect(findModelByRunnerModel('Kimi 2.6')?.recommendedAlias).toBe('kimi');
  });

  // memory === true: general instruct entries also serve the memory workloads.
  // memory === false: search/answer entries keep chat + jobs only.
  it.each([
    ['groq', 'llama-3.3-70b-versatile', true],
    ['groq-fast', 'llama-3.1-8b-instant', true],
    ['groq-oss', 'openai/gpt-oss-120b', true],
    ['deepseek', 'deepseek-v4-pro', true],
    ['deepseek-fast', 'deepseek-v4-flash', true],
    ['grok', 'grok-4.3', true],
    ['grok-fast', 'grok-build-0.1', true],
    ['together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', true],
    ['together-qwen', 'Qwen/Qwen3-235B-A22B-fp8-tput', true],
    ['fireworks', 'accounts/fireworks/models/deepseek-v3p1', true],
    [
      'fireworks-fast',
      'accounts/fireworks/models/llama-v3p1-8b-instruct',
      true,
    ],
    ['cerebras', 'gpt-oss-120b', true],
    ['cerebras-glm', 'zai-glm-4.7', true],
    ['perplexity', 'sonar-pro', false],
    ['perplexity-sonar', 'sonar', false],
    ['gemini', 'gemini-2.5-pro', true],
    ['gemini-flash', 'gemini-2.5-flash', true],
    ['gemini-3-flash', 'gemini-3.5-flash', true],
  ])(
    'resolves the %s alias to its OpenAI-family runner model',
    (alias, runnerModel, memory) => {
      const resolved = resolveModelSelection(alias as string);
      expect(resolved).toMatchObject({ ok: true, alias, runnerModel });
      if (resolved.ok) {
        expect(resolved.entry.responseFamily).toBe('openai');
        expect(resolved.entry.experimental).toBe(true);
        const expectedWorkloads = memory
          ? [
              'chat',
              'one_time_job',
              'recurring_job',
              'memory_extractor',
              'memory_dreaming',
              'memory_consolidation',
            ]
          : ['chat', 'one_time_job', 'recurring_job'];
        expect(resolved.entry.supportedWorkloads).toEqual(expectedWorkloads);
        // The memory workloads must each resolve for memory-eligible entries and
        // be rejected for the search/answer entries (perplexity).
        for (const workload of [
          'memory_extractor',
          'memory_dreaming',
          'memory_consolidation',
        ] as const) {
          const memoryResolved = resolveModelSelectionForWorkload(
            alias as string,
            workload,
          );
          if (memory) {
            expect(memoryResolved.ok).toBe(true);
          } else {
            expect(memoryResolved).toMatchObject({
              ok: false,
              reason: 'unsupported-workload',
            });
          }
        }
      }
    },
  );

  it('keeps the new provider friendly aliases collision-free with existing aliases', () => {
    // Module load already throws on a duplicate alias (buildAliasIndex); this is
    // a belt-and-suspenders check that the headline aliases stay distinct and do
    // not shadow opus/sonnet/haiku/gpt/kimi.
    const headline = [
      'groq',
      'deepseek',
      'grok',
      'together',
      'fireworks',
      'cerebras',
      'perplexity',
      'gemini',
      'opus',
      'sonnet',
      'haiku',
      'gpt',
      'kimi',
    ];
    const runnerModels = headline.map(
      (alias) =>
        resolveModelSelection(alias).ok &&
        (resolveModelSelection(alias) as { runnerModel: string }).runnerModel,
    );
    expect(new Set(runnerModels).size).toBe(headline.length);
  });
});

describe('formatContextWindow', () => {
  it('renders compact labels and a dash for unknown windows', () => {
    expect(formatContextWindow(1_048_576)).toBe('1.0M');
    expect(formatContextWindow(256_000)).toBe('256K');
    expect(formatContextWindow(131_072)).toBe('131K');
    expect(formatContextWindow(127_072)).toBe('127K');
    expect(formatContextWindow(undefined)).toBe('—');
    expect(formatContextWindow(0)).toBe('—');
  });
});

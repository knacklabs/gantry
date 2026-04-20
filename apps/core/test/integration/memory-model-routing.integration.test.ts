import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runClaudeQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@core/memory/claude-query.js', () => ({
  runClaudeQuery: runClaudeQueryMock,
  hasClaudeAuthConfigured: () => true,
}));

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-model-routing-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('@core/core/env.js');
  vi.doUnmock('@core/core/runtime-memory-settings.js');
  runClaudeQueryMock.mockReset();
});

describe('memory model routing integration', () => {
  it('routes extractor/dreaming/consolidation to per-task runtime models', async () => {
    const runtimeRoot = makeTempRoot();
    vi.stubEnv('AGENT_ROOT', runtimeRoot);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-test-token');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-opus-fallback');

    vi.doMock('@core/core/env.js', () => ({
      readEnvFile: () => ({}),
    }));
    vi.doMock('@core/core/runtime-memory-settings.js', () => ({
      readRuntimeMemorySettingsSnapshot: () => ({
        llmExtractorModel: 'model-extractor-custom',
        llmDreamingModel: 'model-dreaming-custom',
        llmConsolidationModel: 'model-consolidation-custom',
      }),
    }));

    runClaudeQueryMock.mockImplementation(
      async ({ model }: { model: string }) => {
        if (model === 'model-extractor-custom') {
          return JSON.stringify([
            {
              scope: 'group',
              kind: 'fact',
              key: 'fact:style',
              value: 'Use concise responses',
              why: 'Preference: use concise responses.',
              confidence: 0.91,
            },
          ]);
        }
        if (model === 'model-dreaming-custom') {
          return '[]';
        }
        if (model === 'model-consolidation-custom') {
          return JSON.stringify({
            key: 'consolidated:deploy_policy',
            value: 'Always run tests before deploy',
            confidence: 0.9,
          });
        }
        return '';
      },
    );

    const [
      { createLlmMemoryExtractionProvider },
      { runDreamingSweep },
      { MemoryStore },
      { consolidateMemoryItems },
    ] = await Promise.all([
      import('@core/memory/extractor-llm.js'),
      import('@core/memory/memory-dreaming.js'),
      import('@core/memory/memory-store.js'),
      import('@core/memory/memory-consolidation.js'),
    ]);

    const extractorFallback = {
      providerName: 'fallback',
      extractFacts: vi.fn(async () => []),
    };
    const extractor = createLlmMemoryExtractionProvider(extractorFallback);
    const extracted = await extractor.extractFacts({
      turns: [
        { role: 'user', text: 'Preference: use concise responses.' },
        {
          role: 'assistant',
          text: 'Acknowledged. I will keep replies concise.',
        },
      ],
      trigger: 'session-end',
      retrievedItems: [],
    });
    expect(extracted.length).toBe(1);

    const dreamingStore = new MemoryStore(
      path.join(makeTempRoot(), 'dream.db'),
    );
    const dreamed = dreamingStore.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'fact:dream',
      value: 'dream candidate',
      source: 'test',
      confidence: 0.7,
    });
    dreamingStore.recordRetrievalSignal(dreamed.id, 0.9, 'q-1');
    dreamingStore.recordRetrievalSignal(dreamed.id, 0.8, 'q-2');
    await runDreamingSweep({
      groupFolder: 'team',
      store: dreamingStore,
      enabled: true,
      consolidateGroupMemory: async () => ({
        enabled: true,
        consideredItems: 1,
        clustersFound: 0,
        clustersProcessed: 0,
        mergedItems: 0,
        retiredItems: 0,
        mode: 'none',
      }),
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
      dryRun: true,
    });

    const consolidationStore = new MemoryStore(
      path.join(makeTempRoot(), 'consolidation.db'),
    );
    const vector = (() => {
      const out = new Array<number>(3072).fill(0);
      out[0] = 1;
      return out;
    })();
    consolidationStore.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'deploy:one',
      value: 'Run tests before deploy',
      source: 'test',
      confidence: 0.8,
    });
    consolidationStore.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'deploy:two',
      value: 'Always run test suite before release',
      source: 'test',
      confidence: 0.82,
    });
    await consolidateMemoryItems({
      groupFolder: 'team',
      store: consolidationStore,
      embeddings: {
        isEnabled: () => true,
        validateConfiguration: () => undefined,
        embedMany: async (texts: string[]) => texts.map(() => vector),
        embedOne: async () => vector,
      },
      minItems: 2,
      clusterThreshold: 0.7,
      maxClusters: 3,
    });

    const calledModels = runClaudeQueryMock.mock.calls
      .map((call) => call[0]?.model)
      .filter((value): value is string => typeof value === 'string');
    expect(calledModels).toContain('model-extractor-custom');
    expect(calledModels).toContain('model-dreaming-custom');
    expect(calledModels).toContain('model-consolidation-custom');
    expect(calledModels).not.toContain('claude-opus-fallback');
  });
});

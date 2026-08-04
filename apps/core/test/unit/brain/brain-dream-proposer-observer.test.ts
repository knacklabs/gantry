import { afterEach, describe, expect, it } from 'vitest';

import {
  MemoryLlmBrainDreamProposer,
  type BrainDreamProposal,
} from '@core/brain/brain-dreaming.js';
import { normalizeSurfaceableInsightDraft } from '@core/brain/observer-insight-emission.js';
import type { BrainPage } from '@core/brain/brain-types.js';
import {
  getMemoryLlmClient,
  registerMemoryLlmClient,
} from '@core/memory/memory-llm-port.js';

const previousClient = getMemoryLlmClient();

afterEach(() => {
  registerMemoryLlmClient(previousClient);
});

describe('observer brain dream proposer', () => {
  it('keeps the legacy array prompt and result unchanged while observer is off', async () => {
    let systemPrompt = '';
    registerMemoryLlmClient({
      isConfigured: () => true,
      query: async (input) => {
        systemPrompt = input.systemPrompt;
        return '[{"action":"upsert_entity","kind":"person","name":"Alice"}]';
      },
    });

    const result = await new MemoryLlmBrainDreamProposer().propose({
      appId: 'default',
      pages: [page],
    });

    expect(result).toEqual([
      { action: 'upsert_entity', kind: 'person', name: 'Alice' },
    ]);
    expect(systemPrompt).toContain('Return strict JSON array operations only.');
    expect(systemPrompt).not.toContain('surfaceableInsights');
  });

  it('rejects malformed observer objects instead of consuming the cursor', async () => {
    registerMemoryLlmClient({
      isConfigured: () => true,
      query: async () => '{}',
    });

    await expect(
      new MemoryLlmBrainDreamProposer().propose({
        appId: 'default',
        pages: [page],
        observerEnabled: true,
      }),
    ).rejects.toThrow(
      'Brain dreaming observer proposal requires operations and surfaceableInsights arrays',
    );
  });

  it('requests all six page insight types in the existing per-page call', async () => {
    let systemPrompt = '';
    registerMemoryLlmClient({
      isConfigured: () => true,
      query: async (input) => {
        systemPrompt = input.systemPrompt;
        return JSON.stringify({
          operations: [],
          surfaceableInsights: [
            {
              insightType: 'commitment',
              title: 'Ship date',
              summary: 'The team committed to Friday.',
              canonicalSignature: 'ship on friday',
              confidence: 0.9,
              evidencePageIds: [page.id],
            },
          ],
        });
      },
    });

    const result = (await new MemoryLlmBrainDreamProposer().propose({
      appId: 'default',
      pages: [page],
      observerEnabled: true,
    })) as BrainDreamProposal;

    expect(result.surfaceableInsights).toHaveLength(1);
    for (const insightType of [
      'commitment',
      'contradiction',
      'open_question',
      'stale_fact',
      'decision_without_owner',
      'duplicated_work',
    ]) {
      expect(systemPrompt).toContain(insightType);
    }
    expect(systemPrompt).toContain(
      'Return one strict JSON object with arrays named operations and surfaceableInsights.',
    );
  });

  it('deduplicates model evidence to at most the current page', () => {
    expect(
      normalizeSurfaceableInsightDraft(
        {
          insightType: 'commitment',
          title: 'Ship date',
          summary: 'The team committed to Friday.',
          canonicalSignature: 'ship on friday',
          confidence: 0.9,
          evidencePageIds: [page.id, page.id, 'another-page', page.id],
        },
        page.id,
      )?.evidencePageIds,
    ).toEqual([page.id]);
  });
});

const page: BrainPage = {
  id: 'page-1',
  appId: 'default',
  slug: 'channel-page',
  title: 'Channel page',
  markdown: 'The team will ship on Friday.',
  sourceKind: 'channel',
  sourceRef: 'slack-one:slack:C123#2026-07-22',
  authorId: null,
  metadata: {},
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
};

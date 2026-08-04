import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMemorySubject } from '@core/memory/memory-types.js';

const memoryLlmQuery = vi.fn();

vi.mock('@core/config/index.js', () => ({
  getMemoryModelRuntimeConfig: () => ({
    extractor: 'claude-haiku-test',
    dreaming: 'claude-sonnet-dreaming-test',
    consolidation: 'claude-sonnet-consolidation-test',
  }),
}));

vi.mock('@core/memory/memory-llm-port.js', () => ({
  getMemoryLlmClient: () => ({
    isConfigured: () => true,
    query: memoryLlmQuery,
  }),
}));

const subject: NormalizedMemorySubject = {
  appId: 'app-a',
  agentId: 'agent-a',
  groupId: 'group-a',
  subjectType: 'group',
  subjectId: 'group-a',
};

describe('memory LLM proposal model selection', () => {
  beforeEach(() => {
    memoryLlmQuery.mockReset();
    memoryLlmQuery.mockResolvedValue('[]');
  });

  it('uses the configured dreaming model for dreaming proposals', async () => {
    const { proposeMemoryDreamingActions } =
      await import('@core/memory/memory-llm-proposals.js');
    const controller = new AbortController();

    await proposeMemoryDreamingActions({
      subject,
      evidence: [],
      candidates: [],
      activeItems: [],
      signal: controller.signal,
      timeoutMs: 42_000,
    });

    expect(memoryLlmQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-dreaming-test',
        signal: controller.signal,
        timeoutMs: 42_000,
      }),
    );
  });

  it('uses the configured consolidation model for consolidation proposals', async () => {
    const { proposeMemoryConsolidationActions } =
      await import('@core/memory/memory-llm-proposals.js');
    const controller = new AbortController();

    await proposeMemoryConsolidationActions({
      subject,
      activeItems: [],
      signal: controller.signal,
      timeoutMs: 84_000,
    });

    expect(memoryLlmQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-consolidation-test',
        signal: controller.signal,
        timeoutMs: 84_000,
      }),
    );
  });

  it("includes each active item's evidence ids so the model can ground both sides", async () => {
    const { proposeMemoryDreamingActions } =
      await import('@core/memory/memory-llm-proposals.js');

    await proposeMemoryDreamingActions({
      subject,
      evidence: [],
      candidates: [],
      activeItems: [
        {
          id: 'mem-1',
          appId: subject.appId,
          agentId: subject.agentId,
          subjectId: subject.subjectId,
          kind: 'decision',
          key: 'decision:queue-policy',
          valueJson: JSON.stringify({ value: 'old value', why: null }),
          sourceRefJson: JSON.stringify({
            subject,
            evidenceIds: ['mev-active'],
          }),
          confidence: 0.8,
          updatedAt: '2026-05-07T00:00:00.000Z',
        } as never,
      ],
    });

    const prompt = memoryLlmQuery.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('"evidence_ids"');
    expect(prompt).toContain('mev-active');
  });

  it('parses a contradiction nomination from a needs_review proposal', async () => {
    const { proposeMemoryDreamingActions } =
      await import('@core/memory/memory-llm-proposals.js');
    memoryLlmQuery.mockResolvedValue(
      JSON.stringify([
        {
          action: 'needs_review',
          item_id: 'mem-1',
          value: 'runtime queue policy belongs under runtime.queue',
          reason: 'active item and candidate disagree',
          confidence: 0.9,
          evidence_ids: ['mev-1'],
          contradiction: {
            type: 'llm_claim_conflict',
            active: { item_id: 'mem-1', evidence_ids: ['mev-active'] },
            incoming: { candidate_id: 'mca-1', evidence_ids: ['mev-1'] },
          },
        },
      ]),
    );

    const proposals = await proposeMemoryDreamingActions({
      subject,
      evidence: [],
      candidates: [],
      activeItems: [],
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].contradictionNomination).toEqual({
      conflictType: 'llm_claim_conflict',
      activeItemId: 'mem-1',
      incomingCandidateId: 'mca-1',
      activeEvidenceIds: ['mev-active'],
      incomingEvidenceIds: ['mev-1'],
    });
  });

  it('drops a proposal whose contradiction field is malformed', async () => {
    const { proposeMemoryDreamingActions } =
      await import('@core/memory/memory-llm-proposals.js');
    memoryLlmQuery.mockResolvedValue(
      JSON.stringify([
        {
          action: 'needs_review',
          item_id: 'mem-1',
          value: 'v',
          reason: 'malformed contradiction payload',
          confidence: 0.9,
          evidence_ids: ['mev-1'],
          contradiction: 'not-an-object',
        },
      ]),
    );

    const proposals = await proposeMemoryDreamingActions({
      subject,
      evidence: [],
      candidates: [],
      activeItems: [],
    });

    expect(proposals).toHaveLength(0);
  });

  it('rethrows aborted dreaming proposal calls instead of swallowing them', async () => {
    const { proposeMemoryDreamingActions } =
      await import('@core/memory/memory-llm-proposals.js');
    const controller = new AbortController();
    const deadline = new Error(
      'memory dreaming deadline exceeded after 5000ms',
    );
    memoryLlmQuery.mockImplementation(
      async (input: { signal?: AbortSignal }) => {
        expect(input.signal).toBe(controller.signal);
        controller.abort(deadline);
        throw deadline;
      },
    );

    await expect(
      proposeMemoryDreamingActions({
        subject,
        evidence: [],
        candidates: [],
        activeItems: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow('memory dreaming deadline exceeded after 5000ms');
  });
});

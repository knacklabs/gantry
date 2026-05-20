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
      await import('@core/memory/extractor-llm.js');

    await proposeMemoryDreamingActions({
      subject,
      evidence: [],
      candidates: [],
      activeItems: [],
    });

    expect(memoryLlmQuery).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-dreaming-test' }),
    );
  });

  it('uses the configured consolidation model for consolidation proposals', async () => {
    const { proposeMemoryConsolidationActions } =
      await import('@core/memory/extractor-llm.js');

    await proposeMemoryConsolidationActions({
      subject,
      activeItems: [],
    });

    expect(memoryLlmQuery).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-consolidation-test' }),
    );
  });
});

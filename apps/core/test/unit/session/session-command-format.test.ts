import { describe, expect, it } from 'vitest';

import { formatMemoryStatus } from '@core/session/session-command-format.js';

describe('formatMemoryStatus', () => {
  it('reports the simple operator memory status', () => {
    const text = formatMemoryStatus({
      items_by_kind: { reference: 1, fact: 2 },
      items_by_scope: { group: 2, common: 1 },
      top10_most_used: [{ key: 'fact:key', retrieval_count: 12 }],
      top10_stalest: [],
      memory_pipeline: {
        staged: 3,
        promoted: 2,
        needs_review: 1,
      },
      last_injected_block: {
        subject: 'channel:team',
        bytes: 4096,
        at: '2026-05-08T00:00:00.000Z',
      },
      retrieval: {
        searchMode: 'lexical_keyword',
        embeddings: 'configured',
        vectorSearch: 'inactive',
      },
    });

    expect(text).toBe(
      [
        'Memory: Needs review',
        'Last dream: never',
        'Review queue: 1',
        'Injected this run: 1',
      ].join('\n'),
    );
  });

  it('reports disabled memory explicitly', () => {
    const text = formatMemoryStatus({
      memory_enabled: false,
      items_by_kind: {},
      items_by_scope: {},
      top10_most_used: [],
      top10_stalest: [],
    });

    expect(text).toBe(
      [
        'Memory: Disabled',
        'Last dream: never',
        'Review queue: 0',
        'Injected this run: 0',
      ].join('\n'),
    );
  });
});

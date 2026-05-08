import { describe, expect, it } from 'vitest';

import { formatMemoryStatus } from '@core/session/session-command-format.js';

describe('formatMemoryStatus', () => {
  it('reports the current retrieval and embedding behavior explicitly', () => {
    const text = formatMemoryStatus({
      items_by_kind: { reference: 1, fact: 2 },
      items_by_scope: { group: 2, common: 1 },
      top10_most_used: [{ key: 'fact:key', retrieval_count: 12 }],
      top10_stalest: [],
      retrieval: {
        searchMode: 'lexical_keyword',
        embeddings: 'configured',
        vectorSearch: 'inactive',
      },
    });

    expect(text).toContain('kinds: fact:2, reference:1');
    expect(text).toContain('scopes: common:1, group:2');
    expect(text).toContain(
      'sample: latest 100 active memories; counts/top/stale are from this sample',
    );
    expect(text).toContain('retrieval: lexical + keyword');
    expect(text).toContain('embeddings: configured');
    expect(text).toContain('vector_search: inactive');
    expect(text).toContain('top_used: fact:key(12)');
  });
});

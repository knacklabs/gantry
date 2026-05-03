import { describe, expect, it } from 'vitest';

import { formatMemoryStatus } from '@core/session/session-command-format.js';

describe('formatMemoryStatus', () => {
  it('reports the current retrieval and embedding behavior explicitly', () => {
    const text = formatMemoryStatus({
      items_by_kind: { fact: 2 },
      items_by_scope: { group: 2 },
      top10_most_used: [],
      top10_stalest: [],
      retrieval: {
        searchMode: 'lexical_keyword',
        embeddings: 'disabled',
        vectorSearch: 'inactive',
      },
    });

    expect(text).toContain('retrieval: lexical + keyword');
    expect(text).toContain('embeddings: disabled');
    expect(text).toContain('vector_search: inactive');
  });
});

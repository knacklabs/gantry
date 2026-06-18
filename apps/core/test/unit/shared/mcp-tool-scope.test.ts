import { describe, expect, it } from 'vitest';

import { normalizeMcpToolScope } from '@core/shared/mcp-tool-scope.js';

describe('normalizeMcpToolScope', () => {
  it('allows empty requested scope to inherit reviewed server tools', () => {
    expect(
      normalizeMcpToolScope({
        serverName: 'crm',
        requested: [],
        definitionPatterns: [],
      }),
    ).toEqual([]);
  });

  it('rejects non-empty requested scope when no server tools were reviewed', () => {
    expect(() =>
      normalizeMcpToolScope({
        serverName: 'crm',
        requested: ['lookup_*'],
        definitionPatterns: [],
      }),
    ).toThrow('server definition has no reviewed tools');
  });

  it('allows requested scope covered by reviewed wildcard patterns', () => {
    expect(
      normalizeMcpToolScope({
        serverName: 'crm',
        requested: ['lookup_order'],
        definitionPatterns: ['lookup_*'],
      }),
    ).toEqual(['lookup_order']);
  });
});

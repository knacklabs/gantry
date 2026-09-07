import { describe, expect, it } from 'vitest';

import {
  isPrincipalRef,
  systemPrincipal,
} from '../../../src/domain/identity/principal-ref.js';

describe('PrincipalRef', () => {
  it('preserves an explicit system source', () => {
    expect(systemPrincipal(' runtime ')).toEqual({
      kind: 'system',
      source: 'runtime',
    });
  });

  it('accepts only complete human, service, or system principals', () => {
    expect(isPrincipalRef({ kind: 'human', personId: 'person:1' })).toBe(true);
    expect(
      isPrincipalRef({
        kind: 'service',
        personId: 'person:agent:1',
        aliasId: 'alias:1',
      }),
    ).toBe(true);
    expect(isPrincipalRef({ kind: 'system', source: 'api-key:key-1' })).toBe(
      true,
    );
    expect(isPrincipalRef({ kind: 'service', agentId: 'agent:1' })).toBe(false);
    expect(isPrincipalRef({ kind: 'system', source: '' })).toBe(false);
  });
});

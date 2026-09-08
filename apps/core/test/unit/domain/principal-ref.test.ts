import { describe, expect, it } from 'vitest';

import {
  isPrincipalRef,
  parsePrincipalRef,
  serializePrincipalRef,
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

  it('round-trips structured values and preserves a legacy actor as system', () => {
    const principal = { kind: 'service' as const, personId: 'person:agent:1' };
    expect(parsePrincipalRef(serializePrincipalRef(principal))).toEqual(
      principal,
    );
    expect(parsePrincipalRef('runtime')).toEqual({
      kind: 'system',
      source: 'runtime',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { resolvePgBossSchema } from '../../../src/shared/pgboss-schema.js';

describe('resolvePgBossSchema', () => {
  it('uses the default schema when no override is configured', () => {
    expect(resolvePgBossSchema(undefined)).toBe('pgboss');
  });

  it('accepts a dedicated Gantry queue schema', () => {
    expect(resolvePgBossSchema(' gantry_pgboss ')).toBe('gantry_pgboss');
  });

  it('rejects unsafe PostgreSQL identifiers', () => {
    expect(() => resolvePgBossSchema('gantry-pgboss')).toThrow(
      'PGBOSS_SCHEMA must be a lowercase PostgreSQL schema identifier',
    );
  });
});

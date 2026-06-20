import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

// Minimal valid source: own DB URL + identity secret (required-mode default).
const base = {
  BOONDI_CRM_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  MCP_IDENTITY_SECRET: 'test-secret',
} as NodeJS.ProcessEnv;

describe('loadEnv — schema separation', () => {
  it('requires BOONDI_CRM_DATABASE_URL (no GANTRY_DATABASE_URL fallback)', () => {
    const { BOONDI_CRM_DATABASE_URL: _omit, ...noUrl } = base;
    expect(() =>
      loadEnv({ ...noUrl, GANTRY_DATABASE_URL: 'postgres://gantry' }),
    ).toThrow(/BOONDI_CRM_DATABASE_URL/);
  });

  it('defaults its own schema to boondi_crm', () => {
    expect(loadEnv(base).dbSchema).toBe('boondi_crm');
  });

  it('rejects an unsafe own-schema name', () => {
    expect(() =>
      loadEnv({ ...base, BOONDI_CRM_DB_SCHEMA: 'bad;name' }),
    ).toThrow(/schema/i);
  });

  it('defaults the gantry read-schema to gantry and honors the override', () => {
    expect(loadEnv(base).gantrySchema).toBe('gantry');
    expect(
      loadEnv({ ...base, BOONDI_CRM_GANTRY_SCHEMA: 'gantry_v2' }).gantrySchema,
    ).toBe('gantry_v2');
  });
});

describe('loadEnv extractorModel', () => {
  it('defaults to claude-sonnet-4-6', () => {
    expect(loadEnv({ ...base } as never).extractorModel).toBe('claude-sonnet-4-6');
  });
  it('honors BOONDI_CRM_EXTRACTOR_MODEL', () => {
    expect(
      loadEnv({ ...base, BOONDI_CRM_EXTRACTOR_MODEL: 'claude-haiku-4-5' } as never)
        .extractorModel,
    ).toBe('claude-haiku-4-5');
  });
});

describe('loadEnv digest watcher', () => {
  it('enables the digest watcher by default', () => {
    expect(loadEnv({ ...base } as never).disableDigestWatcher).toBe(false);
  });

  it('honors BOONDI_CRM_DISABLE_DIGEST_WATCHER', () => {
    expect(
      loadEnv({
        ...base,
        BOONDI_CRM_DISABLE_DIGEST_WATCHER: 'true',
      } as never).disableDigestWatcher,
    ).toBe(true);
  });
});

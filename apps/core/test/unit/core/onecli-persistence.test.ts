import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractOnecliDatabaseSchema,
  generateOnecliSecretEncryptionKey,
  getPostgresDatabaseIdentity,
  inspectOnecliPersistenceReadiness,
  renderOnecliDatabaseUrl,
  validateSharedPostgresDatabase,
  validateOnecliDatabaseUrl,
  validateOnecliSecretEncryptionKey,
} from '@core/adapters/credentials/onecli/local/persistence.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('OneCLI persistence contract', () => {
  it('renders a schema-isolated database URL using Prisma schema parameter', () => {
    const url = renderOnecliDatabaseUrl({
      postgresUrl:
        'postgresql://user:pass@db.example.com:5432/myclaw?sslmode=require',
      schema: 'onecli',
    });

    expect(url).toContain('sslmode=require');
    expect(extractOnecliDatabaseSchema(url)).toBe('onecli');
    expect(
      validateOnecliDatabaseUrl({ postgresUrl: url, schema: 'onecli' }),
    ).toEqual({
      ok: true,
    });
  });

  it('rejects database URLs without the OneCLI schema parameter', () => {
    const result = validateOnecliDatabaseUrl({
      postgresUrl:
        'postgresql://user:pass@localhost:5432/myclaw?sslmode=require',
      schema: 'onecli',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('schema=onecli');
    }
  });

  it('supports custom broker schema names', () => {
    const url = renderOnecliDatabaseUrl({
      postgresUrl: 'postgresql://user:pass@localhost:5432/myclaw',
      schema: 'agent_vault',
    });

    expect(extractOnecliDatabaseSchema(url)).toBe('agent_vault');
    expect(
      validateOnecliDatabaseUrl({
        postgresUrl: url,
        schema: 'agent_vault',
      }),
    ).toEqual({ ok: true });
  });

  it('rejects mixed-case broker schema names before rendering the URL', () => {
    expect(() =>
      renderOnecliDatabaseUrl({
        postgresUrl: 'postgresql://user:pass@localhost:5432/myclaw',
        schema: 'AgentVault',
      }),
    ).toThrow(/lowercase PostgreSQL identifier/);
  });

  it('normalizes and validates the shared database identity', () => {
    expect(
      getPostgresDatabaseIdentity(
        'postgresql://myclaw:pass@DB.EXAMPLE.com/myclaw?sslmode=require',
      ),
    ).toEqual({
      hostname: 'db.example.com',
      port: '5432',
      database: 'myclaw',
    });

    expect(
      validateSharedPostgresDatabase({
        myclawPostgresUrl:
          'postgresql://myclaw:pass@db.example.com:5432/myclaw?sslmode=require',
        onecliPostgresUrl:
          'postgresql://onecli:pass@db.example.com/myclaw?sslmode=require&schema=onecli',
      }),
    ).toEqual({ ok: true });

    const mismatch = validateSharedPostgresDatabase({
      myclawPostgresUrl:
        'postgresql://myclaw:pass@db.example.com:5432/myclaw?sslmode=require',
      onecliPostgresUrl:
        'postgresql://onecli:pass@db.example.com:5432/other?sslmode=require&schema=onecli',
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.message).toContain('same Postgres database');
    }
  });

  it('replaces any existing Prisma schema parameter with the configured schema', () => {
    const url = renderOnecliDatabaseUrl({
      postgresUrl:
        'postgresql://user:pass@localhost:5432/myclaw?schema=public&sslmode=require',
      schema: 'onecli',
    });

    expect(extractOnecliDatabaseSchema(url)).toBe('onecli');
    expect(new URL(url).searchParams.get('sslmode')).toBe('require');
  });

  it('requires a stable encryption key before probing the database', async () => {
    const url = renderOnecliDatabaseUrl({
      postgresUrl: 'postgresql://user:pass@localhost:5432/myclaw',
      schema: 'onecli',
    });

    await expect(
      inspectOnecliPersistenceReadiness({
        postgresUrl: url,
        schema: 'onecli',
        secretEncryptionKey: '',
      }),
    ).resolves.toMatchObject({
      status: 'fail',
      message: expect.stringContaining('SECRET_ENCRYPTION_KEY'),
    });
  });

  it('rejects weak encryption keys before probing the database', async () => {
    const url = renderOnecliDatabaseUrl({
      postgresUrl: 'postgresql://onecli:pass@localhost:5432/myclaw',
      schema: 'onecli',
    });

    await expect(
      inspectOnecliPersistenceReadiness({
        postgresUrl: url,
        schema: 'onecli',
        secretEncryptionKey: 'short',
      }),
    ).resolves.toMatchObject({
      status: 'fail',
      message: expect.stringContaining('base64-encoded 32-byte'),
    });
  });

  it('validates generated base64-encoded 32-byte encryption secrets', () => {
    const generated = generateOnecliSecretEncryptionKey();

    expect(generated).toHaveLength(44);
    expect(generated).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(validateOnecliSecretEncryptionKey(generated)).toEqual({ ok: true });
  });

  it('rejects repeated or phrase-like encryption secrets', () => {
    const repeated = validateOnecliSecretEncryptionKey('a'.repeat(44));
    expect(repeated.ok).toBe(false);

    const phrase = validateOnecliSecretEncryptionKey(
      'this-is-a-secret-phrase-that-is-long-enough',
    );
    expect(phrase.ok).toBe(false);
  });

  it('rejects shared MyClaw and OneCLI database roles', async () => {
    const url = renderOnecliDatabaseUrl({
      postgresUrl: 'postgresql://shared:pass@localhost:5432/myclaw',
      schema: 'onecli',
    });

    await expect(
      inspectOnecliPersistenceReadiness({
        postgresUrl: url,
        schema: 'onecli',
        secretEncryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY=',
        myclawPostgresUrl: 'postgresql://shared:pass@localhost:5432/myclaw',
      }),
    ).resolves.toMatchObject({
      status: 'fail',
      message: expect.stringContaining('different Postgres roles'),
    });
  });

  it('rejects different MyClaw and OneCLI databases before probing', async () => {
    const url = renderOnecliDatabaseUrl({
      postgresUrl: 'postgresql://onecli:pass@localhost:5432/other',
      schema: 'onecli',
    });

    await expect(
      inspectOnecliPersistenceReadiness({
        postgresUrl: url,
        schema: 'onecli',
        secretEncryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY=',
        myclawPostgresUrl: 'postgresql://myclaw:pass@localhost:5432/myclaw',
      }),
    ).resolves.toMatchObject({
      status: 'fail',
      message: expect.stringContaining('same Postgres database'),
    });
  });

  it('fails readiness when the MyClaw role can access the OneCLI schema', async () => {
    vi.resetModules();
    const queryByConnection = new Map<string, any[]>([
      [
        'postgresql://onecli:pass@localhost:5432/myclaw?schema=onecli',
        [
          { rows: [{ current_user: 'onecli' }] },
          { rows: [{ exists: true }] },
          { rows: [{ current_schema: 'onecli' }] },
          { rows: [{ has_access: false }] },
          { rows: [{ has_access: false }] },
          { rows: [] },
        ],
      ],
      [
        'postgresql://myclaw:pass@localhost:5432/myclaw',
        [
          { rows: [{ current_user: 'myclaw' }] },
          { rows: [{ has_access: true }] },
          { rows: [{ has_access: false }] },
        ],
      ],
    ]);
    vi.doMock('pg', () => ({
      Pool: class {
        private readonly responses: any[];

        constructor(config: { connectionString: string }) {
          this.responses = [
            ...(queryByConnection.get(config.connectionString) || []),
          ];
        }

        async query() {
          const response = this.responses.shift();
          if (!response) throw new Error('unexpected query');
          return response;
        }

        async end() {}
      },
    }));
    const { inspectOnecliPersistenceReadiness: inspectReadiness } =
      await import('@core/adapters/credentials/onecli/local/persistence.js');

    await expect(
      inspectReadiness({
        postgresUrl:
          'postgresql://onecli:pass@localhost:5432/myclaw?schema=onecli',
        schema: 'onecli',
        secretEncryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY=',
        myclawPostgresUrl: 'postgresql://myclaw:pass@localhost:5432/myclaw',
        myclawSchema: 'myclaw',
      }),
    ).resolves.toMatchObject({
      status: 'fail',
      message: expect.stringContaining('MyClaw database role'),
    });
  });

  it('fails readiness when the OneCLI role can create in the MyClaw schema', async () => {
    vi.resetModules();
    vi.doMock('pg', () => ({
      Pool: class {
        private readonly responses = [
          { rows: [{ current_user: 'onecli' }] },
          { rows: [{ exists: true }] },
          { rows: [{ current_schema: 'onecli' }] },
          { rows: [{ has_access: false }] },
          { rows: [{ has_access: true }] },
        ];

        async query() {
          const response = this.responses.shift();
          if (!response) throw new Error('unexpected query');
          return response;
        }

        async end() {}
      },
    }));
    const { inspectOnecliPersistenceReadiness: inspectReadiness } =
      await import('@core/adapters/credentials/onecli/local/persistence.js');

    await expect(
      inspectReadiness({
        postgresUrl:
          'postgresql://onecli:pass@localhost:5432/myclaw?schema=onecli',
        schema: 'onecli',
        secretEncryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY=',
        myclawSchema: 'myclaw',
      }),
    ).resolves.toMatchObject({
      status: 'fail',
      message: expect.stringContaining('OneCLI database role'),
    });
  });

  it('fails readiness when the OneCLI role search_path resolves to public', async () => {
    vi.resetModules();
    vi.doMock('pg', () => ({
      Pool: class {
        private readonly responses = [
          { rows: [{ current_user: 'onecli' }] },
          { rows: [{ exists: true }] },
          { rows: [{ current_schema: 'public' }] },
        ];

        async query() {
          const response = this.responses.shift();
          if (!response) throw new Error('unexpected query');
          return response;
        }

        async end() {}
      },
    }));
    const { inspectOnecliPersistenceReadiness: inspectReadiness } =
      await import('@core/adapters/credentials/onecli/local/persistence.js');

    await expect(
      inspectReadiness({
        postgresUrl:
          'postgresql://onecli:pass@localhost:5432/myclaw?schema=onecli',
        schema: 'onecli',
        secretEncryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY=',
      }),
    ).resolves.toMatchObject({
      status: 'fail',
      message: expect.stringContaining('search_path'),
      details: ['current_schema=public', 'expected_schema=onecli'],
    });
  });

  it('fails readiness when application tables exist in public', async () => {
    vi.resetModules();
    vi.doMock('pg', () => ({
      Pool: class {
        private readonly responses = [
          { rows: [{ current_user: 'onecli' }] },
          { rows: [{ exists: true }] },
          { rows: [{ current_schema: 'onecli' }] },
          { rows: [{ has_access: false }] },
          { rows: [{ has_access: false }] },
          { rows: [{ table_name: 'credentials' }] },
        ];

        async query() {
          const response = this.responses.shift();
          if (!response) throw new Error('unexpected query');
          return response;
        }

        async end() {}
      },
    }));
    const { inspectOnecliPersistenceReadiness: inspectReadiness } =
      await import('@core/adapters/credentials/onecli/local/persistence.js');

    await expect(
      inspectReadiness({
        postgresUrl:
          'postgresql://onecli:pass@localhost:5432/myclaw?schema=onecli',
        schema: 'onecli',
        secretEncryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY=',
        myclawSchema: 'myclaw',
      }),
    ).resolves.toMatchObject({
      status: 'fail',
      message: expect.stringContaining(
        'Public schema contains application tables',
      ),
      details: ['public.credentials'],
    });
  });

  it('generates a URL-safe encryption secret', () => {
    expect(generateOnecliSecretEncryptionKey()).toMatch(
      /^[A-Za-z0-9+/]+={0,2}$/,
    );
  });
});

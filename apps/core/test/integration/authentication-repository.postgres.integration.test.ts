import { afterAll, beforeAll, expect, it } from 'vitest';

import { PostgresAuthenticationRepository } from '@core/adapters/storage/postgres/repositories/authentication-repository.postgres.js';
import { oidcTransactionsPostgres } from '@core/adapters/storage/postgres/schema/authentication.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import { DEFAULT_APP_ID } from '@core/adapters/storage/postgres/seeds.js';

const databaseUrl = process.env.GANTRY_TEST_DATABASE_URL;
const maybeIt = databaseUrl ? it : it.skip;
let service: PostgresStorageService;
let repository: PostgresAuthenticationRepository;
let schemaName: string;
const now = '2026-08-18T00:00:00.000Z';

beforeAll(async () => {
  if (!databaseUrl) return;
  schemaName = `authentication_repository_${process.pid}_${Date.now()}`;
  service = new PostgresStorageService(databaseUrl, schemaName);
  await service.migrate();
  repository = new PostgresAuthenticationRepository(service.db);
});

afterAll(async () => {
  if (!service) return;
  await service.pool.query(
    `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
  );
  await service.close();
});

maybeIt('applies the authentication follow-up columns', async () => {
  const result = await service.pool.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND (table_name, column_name) IN (
           ('oidc_transactions', 'nonce_hash'),
           ('oidc_transactions', 'oidc_config_json'),
           ('oidc_transactions', 'configuration_test'),
           ('oidc_transactions', 'reauthenticate_session_hash'),
           ('console_invitations', 'revoked_at')
         )`,
    [schemaName],
  );

  expect(result.rows).toHaveLength(5);
});

maybeIt(
  'consumes a local authorization code once under concurrent requests',
  async () => {
    const appId = DEFAULT_APP_ID;
    const userId = await repository.ensureLocalAdministrator(appId, now);
    await repository.createLocalAuthorizationCode({
      appId,
      userId,
      tokenHash: 'test-token-hash',
      canonicalHost: '127.0.0.1:18789',
      expiresAt: '2026-08-18T00:10:00.000Z',
      now,
    });

    const results = await Promise.all([
      repository.consumeLocalAuthorizationCode(
        'test-token-hash',
        '127.0.0.1:18789',
        now,
      ),
      repository.consumeLocalAuthorizationCode(
        'test-token-hash',
        '127.0.0.1:18789',
        now,
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(
      repository.localAuthorizationCodeStatus(
        'test-token-hash',
        '127.0.0.1:18789',
        now,
      ),
    ).resolves.toBe('used');
  },
);

maybeIt(
  'deletes an expired OIDC configuration transaction when it is consumed',
  async () => {
    await repository.createOidcTransaction({
      id: 'oidc-configuration-test',
      appId: DEFAULT_APP_ID,
      stateHash: 'state-hash',
      nonceHash: 'nonce-hash',
      encryptedPkceVerifier: 'encrypted-verifier',
      oidcConfigJson: JSON.stringify({ issuer: 'https://issuer.example' }),
      configurationTest: true,
      expiresAt: '2026-08-18T00:01:00.000Z',
      now,
    });

    await expect(
      repository.consumeOidcTransaction(
        'state-hash',
        '2026-08-18T00:02:00.000Z',
      ),
    ).resolves.toBeNull();
    await expect(
      repository.consumeOidcTransaction(
        'state-hash',
        '2026-08-18T00:02:00.000Z',
      ),
    ).resolves.toBeNull();
    await expect(
      service.db.select().from(oidcTransactionsPostgres),
    ).resolves.toEqual([]);
  },
);

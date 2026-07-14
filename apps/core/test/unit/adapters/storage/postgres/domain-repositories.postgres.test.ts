import { describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  parseRuntimeSecretRefsJson,
  PostgresProviderAccountRepository,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import { PostgresOutboundDeliveryRepository } from '@core/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.js';
import {
  conversationInstallsPostgres,
  providerAccountsPostgres,
} from '@core/adapters/storage/postgres/schema/providers.js';

describe('createPostgresDomainRepositories', () => {
  it('wires outbound delivery repository into the domain bundle', () => {
    const repositories = createPostgresDomainRepositories({} as never);
    expect(repositories.outboundDeliveries).toBeInstanceOf(
      PostgresOutboundDeliveryRepository,
    );
    expect(repositories.providerAccounts).toBeInstanceOf(
      PostgresProviderAccountRepository,
    );
  });
});

describe('provider account schema', () => {
  it('persists ownership and native identity evidence without trigger routing', () => {
    expect(providerAccountsPostgres.agentId.name).toBe('agent_id');
    expect(providerAccountsPostgres.externalIdentityRefJson.name).toBe(
      'external_identity_ref_json',
    );
    expect(conversationInstallsPostgres.providerAccountId.name).toBe(
      'provider_account_id',
    );
    expect(conversationInstallsPostgres.senderPolicy.name).toBe(
      'sender_policy',
    );
    expect(conversationInstallsPostgres).not.toHaveProperty('triggerPattern');
    expect(conversationInstallsPostgres).not.toHaveProperty('requiresTrigger');
  });
});

describe('parseRuntimeSecretRefsJson', () => {
  it('parses credential-keyed runtime secret refs', () => {
    expect(
      parseRuntimeSecretRefsJson(
        '{"bot_token":"env:SLACK_BOT_TOKEN"}',
        'slack',
      ),
    ).toEqual({ bot_token: 'env:SLACK_BOT_TOKEN' });
  });

  it('rejects array-shaped runtime secret refs', () => {
    expect(() =>
      parseRuntimeSecretRefsJson('["SLACK_BOT_TOKEN"]', 'slack'),
    ).toThrow(
      'provider account slack runtimeSecretRefs must be a JSON object keyed by credential name',
    );
  });
});

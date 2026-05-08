import { describe, expect, it } from 'vitest';

import { createPostgresDomainRepositories } from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import { PostgresOutboundDeliveryRepository } from '@core/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.js';

describe('createPostgresDomainRepositories', () => {
  it('wires outbound delivery repository into the domain bundle', () => {
    const repositories = createPostgresDomainRepositories({} as never);
    expect(repositories.outboundDeliveries).toBeInstanceOf(
      PostgresOutboundDeliveryRepository,
    );
  });
});

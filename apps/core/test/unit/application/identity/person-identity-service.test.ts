import { describe, expect, it, vi } from 'vitest';

import { AddPersonAliasRequestSchema } from '@gantry/contracts';

import {
  PersonIdentityService,
  type PersonIdentityRepository,
} from '@core/application/identity/person-identity-service.js';

describe('person identity service', () => {
  it('normalises contact aliases at write time', async () => {
    const addAlias = vi.fn(async (input) => ({
      ...input,
      id: 'alias-1',
      verificationStatus: 'unverified' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }));
    const repository = { addAlias } as unknown as PersonIdentityRepository;
    const service = new PersonIdentityService(repository);

    await service.addAlias({
      appId: 'app-one',
      personId: 'person-one',
      provider: ' EMAIL ',
      externalUserId: ' Person@Example.COM ',
      evidenceType: 'email',
      actor: 'test',
    });
    await service.addAlias({
      appId: 'app-one',
      personId: 'person-one',
      provider: 'phone',
      externalUserId: '00 44 20 7946 0958',
      evidenceType: 'phone',
      actor: 'test',
    });

    expect(addAlias).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: 'email',
        externalUserId: 'person@example.com',
      }),
      undefined,
    );
    expect(addAlias).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: 'phone',
        externalUserId: '+442079460958',
      }),
      undefined,
    );
  });

  it('never exposes verified as a People API alias input', () => {
    const parsed = AddPersonAliasRequestSchema.parse({
      provider: 'email',
      externalUserId: 'person@example.com',
      evidenceType: 'email',
      verificationStatus: 'verified',
      verifiedAt: '2026-08-01T00:00:00.000Z',
      verifiedBy: 'api-client',
    });

    expect(parsed).not.toHaveProperty('verificationStatus');
    expect(parsed).not.toHaveProperty('verifiedAt');
    expect(parsed).not.toHaveProperty('verifiedBy');
  });
});

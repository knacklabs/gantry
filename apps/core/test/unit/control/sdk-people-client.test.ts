import { describe, expect, it } from 'vitest';

import {
  createIdentityClient,
  createPeopleClient,
} from '../../../../../packages/sdk/src/people.js';
import type { RequestOptions } from '../../../../../packages/sdk/src/types.js';

describe('@gantry/sdk People client', () => {
  it('builds every identity and People request path and body', async () => {
    const requests: RequestOptions[] = [];
    const request = async <T>(options: RequestOptions): Promise<T> => {
      requests.push(options);
      return {} as T;
    };
    const identity = createIdentityClient(request);
    const people = createPeopleClient(request);

    await identity.resolve({
      appId: 'app/one',
      provider: 'email',
      providerAccountId: null,
      externalUserId: 'person@example.com',
      displayName: null,
      evidenceType: 'email',
      createIfMissing: true,
    });
    await people.list({ appId: 'app/one', limit: 25, cursor: 'next-page' });
    await people.get('person/one', { appId: 'app/one' });
    await people.aliases.add('person/one', {
      appId: 'app/one',
      provider: 'slack',
      providerAccountId: null,
      externalUserId: 'U1',
      displayName: null,
      evidenceType: 'provider_user',
      evidence: { source: 'admin' },
    });
    await people.aliases.retire('person/one', 'alias/one', {
      appId: 'app/one',
    });
    await people.merge.preview('person/target', {
      appId: 'app/one',
      sourcePersonId: 'person/source',
      conflictResolution: 'keep_target',
    });
    await people.merge.apply('person/target', {
      appId: 'app/one',
      sourcePersonId: 'person/source',
      idempotencyKey: 'merge-1',
      conflictResolution: 'fail_on_conflict',
    });

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/v1/identity/resolve',
        body: {
          appId: 'app/one',
          provider: 'email',
          providerAccountId: null,
          externalUserId: 'person@example.com',
          displayName: null,
          evidenceType: 'email',
          createIfMissing: true,
        },
      },
      {
        method: 'GET',
        path: '/v1/people?appId=app%2Fone&limit=25&cursor=next-page',
      },
      {
        method: 'GET',
        path: '/v1/people/person%2Fone?appId=app%2Fone',
      },
      {
        method: 'POST',
        path: '/v1/people/person%2Fone/aliases',
        body: {
          appId: 'app/one',
          provider: 'slack',
          providerAccountId: null,
          externalUserId: 'U1',
          displayName: null,
          evidenceType: 'provider_user',
          evidence: { source: 'admin' },
        },
      },
      {
        method: 'DELETE',
        path: '/v1/people/person%2Fone/aliases/alias%2Fone?appId=app%2Fone',
      },
      {
        method: 'POST',
        path: '/v1/people/person%2Ftarget/merge:preview',
        body: {
          appId: 'app/one',
          sourcePersonId: 'person/source',
          conflictResolution: 'keep_target',
        },
      },
      {
        method: 'POST',
        path: '/v1/people/person%2Ftarget/merge',
        body: {
          appId: 'app/one',
          sourcePersonId: 'person/source',
          idempotencyKey: 'merge-1',
          conflictResolution: 'fail_on_conflict',
        },
      },
    ]);
  });
});

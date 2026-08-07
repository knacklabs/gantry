import { describe, expect, it } from 'vitest';

import { createModelsClient } from '../../../../../packages/sdk/src/models.js';
import type { RequestOptions } from '../../../../../packages/sdk/src/types.js';

describe('@gantry/sdk Models client', () => {
  it('builds every model-credential request path and body', async () => {
    const requests: RequestOptions[] = [];
    const request = async <T>(options: RequestOptions): Promise<T> => {
      requests.push(options);
      return {} as T;
    };
    const credentials = createModelsClient({ request }).credentials;

    await credentials.list();
    await credentials.put('anthropic/primary', {
      authMode: 'api_key',
      payload: { apiKey: 'secret' },
    });
    await credentials.patch('anthropic/primary', {
      payload: { apiKey: 'rotated' },
    });
    await credentials.disable('anthropic/primary');

    expect(requests).toEqual([
      { method: 'GET', path: '/v1/credentials/models' },
      {
        method: 'PUT',
        path: '/v1/credentials/models/anthropic%2Fprimary',
        body: {
          authMode: 'api_key',
          payload: { apiKey: 'secret' },
        },
      },
      {
        method: 'PATCH',
        path: '/v1/credentials/models/anthropic%2Fprimary',
        body: { payload: { apiKey: 'rotated' } },
      },
      {
        method: 'DELETE',
        path: '/v1/credentials/models/anthropic%2Fprimary',
      },
    ]);
  });
});

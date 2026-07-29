import { afterEach, describe, expect, it } from 'vitest';

import { runtimeStorageScopeKey } from '@core/adapters/storage/postgres/factory.js';
import { GANTRY_HOME } from '@core/config/index.js';

describe('runtime storage scope key', () => {
  const previousGantryHome = process.env.GANTRY_HOME;

  afterEach(() => {
    if (previousGantryHome === undefined) delete process.env.GANTRY_HOME;
    else process.env.GANTRY_HOME = previousGantryHome;
  });

  it('uses the configured default home when GANTRY_HOME is blank', () => {
    process.env.GANTRY_HOME = '   ';
    const storageConfig = {
      postgresUrl: 'postgresql://scope:scope@localhost/scope',
      postgresUrlEnv: 'GANTRY_DATABASE_URL',
      postgresSchema: 'gantry',
    };

    expect(runtimeStorageScopeKey({ storageConfig })).toBe(
      runtimeStorageScopeKey({ runtimeHome: GANTRY_HOME, storageConfig }),
    );
  });
});

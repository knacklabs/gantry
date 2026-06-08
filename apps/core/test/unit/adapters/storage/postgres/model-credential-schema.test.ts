import { describe, expect, it } from 'vitest';

import { modelCredentialsPostgres } from '@core/adapters/storage/postgres/schema/model-credentials.js';

describe('modelCredentialsPostgres schema', () => {
  it('persists credential auth mode as non-secret metadata', () => {
    expect(modelCredentialsPostgres.authMode.name).toBe('auth_mode');
    expect(modelCredentialsPostgres.payloadEncrypted.name).toBe(
      'payload_encrypted',
    );
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  encryptCredentialSecretValue,
  modelCredentialAadContext,
  type RuntimeSecretProvider,
} from '@gantry/credential-crypto';
import { bootstrapGantryCredentials } from '../src/gantry-credentials.js';

const TEST_KEY = Buffer.alloc(32, 9).toString('base64');

// A RuntimeSecretProvider over an explicit (possibly undefined) key. No
// process.env, no ~/gantry/.env — the same shape the connector builds from
// ~/gantry/.env. NOTE: no default-parameter on `key` — a default would coerce a
// passed `undefined` back to the key (JS default-param semantics), silently
// defeating the no-key path. Use noKeyProvider() to mean "no key".
function makeProvider(key: string | undefined): RuntimeSecretProvider {
  return {
    getSecret(ref) {
      const v = this.getOptionalSecret(ref);
      if (!v) throw new Error(`${ref.env} missing`);
      return v;
    },
    getOptionalSecret(ref) {
      return ref.env === 'SECRET_ENCRYPTION_KEY' ? key : undefined;
    },
  };
}

// Provider holding the test key (decryption succeeds).
const keyProvider = (): RuntimeSecretProvider => makeProvider(TEST_KEY);
// Provider holding no key (forces the gantry_creds_no_key no-op).
const noKeyProvider = (): RuntimeSecretProvider => makeProvider(undefined);

// Encrypt a payload the way core's model-credential repo stores it: JSON with an
// oauthToken field, AAD from modelCredentialAadContext, mode claude_code_oauth.
function makeCiphertext(token: string, appId = 'default'): string {
  return encryptCredentialSecretValue(
    JSON.stringify({ oauthToken: token }),
    modelCredentialAadContext({
      appId,
      providerId: 'anthropic',
      authMode: 'claude_code_oauth',
      schemaVersion: 1,
    }),
    keyProvider(),
  );
}

// Minimal mock pool: one active anthropic row.
function poolWithRow(row: Record<string, unknown> | null): Pool {
  const query = vi.fn(async () => ({ rows: row ? [row] : [] }));
  return { query } as unknown as Pool;
}

const APP_ID = 'default';

afterEach(() => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('bootstrapGantryCredentials', () => {
  it('decrypts the active anthropic row and projects CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const log = vi.fn();
    const pool = poolWithRow({
      payload_encrypted: makeCiphertext('sk-ant-oat01-decrypted'),
      auth_mode: 'claude_code_oauth',
      schema_version: 1,
    });

    await bootstrapGantryCredentials(pool, {
      appId: APP_ID,
      secrets: keyProvider(),
      log,
    });

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-decrypted');
    expect(log).toHaveBeenCalledWith('gantry_creds_loaded', expect.any(Object));
  });

  it('no-ops (token wins) when ANTHROPIC_API_KEY is already set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-raw';
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    const log = vi.fn();

    await bootstrapGantryCredentials(pool, {
      appId: APP_ID,
      secrets: keyProvider(),
      log,
    });

    expect(query).not.toHaveBeenCalled();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('no-ops with a log when there is no active row', async () => {
    const log = vi.fn();
    const pool = poolWithRow(null);

    await bootstrapGantryCredentials(pool, {
      appId: APP_ID,
      secrets: keyProvider(),
      log,
    });

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(log).toHaveBeenCalledWith('gantry_creds_no_row', expect.any(Object));
  });

  it('no-ops with a log when SECRET_ENCRYPTION_KEY is missing', async () => {
    const log = vi.fn();
    const pool = poolWithRow({
      payload_encrypted: makeCiphertext('sk-ant-oat01-decrypted'),
      auth_mode: 'claude_code_oauth',
      schema_version: 1,
    });

    await bootstrapGantryCredentials(pool, {
      appId: APP_ID,
      secrets: noKeyProvider(), // no key
      log,
    });

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      'gantry_creds_no_key',
      expect.any(Object),
    );
  });

  it('does not crash on malformed ciphertext; logs and disables', async () => {
    const log = vi.fn();
    const pool = poolWithRow({
      payload_encrypted: 'gcred:v2:deadbeefdeadbeef:bad:bad:bad',
      auth_mode: 'claude_code_oauth',
      schema_version: 1,
    });

    await bootstrapGantryCredentials(pool, {
      appId: APP_ID,
      secrets: keyProvider(),
      log,
    });

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      'gantry_creds_decrypt_failed',
      expect.any(Object),
    );
  });
});

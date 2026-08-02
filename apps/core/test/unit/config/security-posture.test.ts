import { describe, expect, it } from 'vitest';

import {
  isLocalControlHost,
  resolveRuntimeSecurityPosture,
  validateProductionSecurityGate,
} from '@core/shared/security-posture.js';

const encryptionKey = Buffer.from(
  '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
  'hex',
).toString('base64');
const strongToken = 'control-token-6bc88e9f0a1249d9b5fd7a1a';
const strongIpcSecret = 'ipc-6bc88e9f0a1249d9b5fd7a1a7c33fbec';

describe('runtime security posture', () => {
  it('treats loopback TCP control as local', () => {
    expect(isLocalControlHost('127.0.0.1')).toBe(true);
    expect(isLocalControlHost('localhost')).toBe(true);
    expect(isLocalControlHost('::1')).toBe(true);
    expect(isLocalControlHost('0.0.0.0')).toBe(false);
  });

  it('requires production secrets for production or non-loopback control', () => {
    expect(
      resolveRuntimeSecurityPosture({
        NODE_ENV: 'production',
      }).requiresProductionSecrets,
    ).toBe(true);
    expect(
      resolveRuntimeSecurityPosture({
        GANTRY_CONTROL_PORT: '7331',
        GANTRY_CONTROL_HOST: '0.0.0.0',
      }).requiresProductionSecrets,
    ).toBe(true);
    expect(
      resolveRuntimeSecurityPosture({
        GANTRY_CONTROL_PORT: '7331',
        GANTRY_CONTROL_HOST: '127.0.0.1',
      }).requiresProductionSecrets,
    ).toBe(false);
    expect(
      resolveRuntimeSecurityPosture({
        GANTRY_SECURITY_POSTURE: 'local',
        GANTRY_RUNTIME_ENV: 'production',
      }).requiresProductionSecrets,
    ).toBe(true);
    expect(
      resolveRuntimeSecurityPosture({
        GANTRY_SECURITY_POSTURE: 'local',
        GANTRY_RUNTIME_ENV: 'remote',
      }).requiresProductionSecrets,
    ).toBe(true);
  });

  it('never requires an enforcing sandbox regardless of posture (two-axis model)', () => {
    expect(
      resolveRuntimeSecurityPosture({ NODE_ENV: 'production' })
        .requiresEnforcingSandbox,
    ).toBe(false);
    expect(
      resolveRuntimeSecurityPosture({ GANTRY_SECURITY_POSTURE: 'remote' })
        .requiresEnforcingSandbox,
    ).toBe(false);
    expect(resolveRuntimeSecurityPosture({}).requiresEnforcingSandbox).toBe(
      false,
    );
  });

  it('allows local development without production secret material', () => {
    expect(validateProductionSecurityGate({ env: {} })).toEqual([]);
  });

  it('fails production mode without required secrets and keys', () => {
    const failures = validateProductionSecurityGate({
      env: {
        NODE_ENV: 'production',
        REMOTE_CONTROL_AUTO_ACCEPT: '1',
      },
      sandboxProvider: 'direct',
    });

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('SECRET_ENCRYPTION_KEY'),
        expect.stringContaining('GANTRY_IPC_AUTH_SECRET'),
        expect.stringContaining('REMOTE_CONTROL_AUTO_ACCEPT'),
        expect.stringContaining('GANTRY_CONTROL_API_KEYS_JSON'),
      ]),
    );
  });

  it('allows explicit false remote auto-accept flags in production mode', () => {
    const baseEnv = {
      NODE_ENV: 'production',
      SECRET_ENCRYPTION_KEY: encryptionKey,
      GANTRY_IPC_AUTH_SECRET: strongIpcSecret,
      GANTRY_CONTROL_API_KEYS_JSON: JSON.stringify([
        {
          kid: 'admin',
          token: strongToken,
          appId: 'default',
          scopes: ['sessions:read'],
        },
      ]),
    };

    expect(
      validateProductionSecurityGate({
        env: { ...baseEnv, REMOTE_CONTROL_AUTO_ACCEPT: 'false' },
        sandboxProvider: 'sandbox_runtime',
      }),
    ).toEqual([]);
    expect(
      validateProductionSecurityGate({
        env: { ...baseEnv, REMOTE_CONTROL_AUTO_ACCEPT: '0' },
        sandboxProvider: 'sandbox_runtime',
      }),
    ).toEqual([]);
    expect(
      validateProductionSecurityGate({
        env: { ...baseEnv, REMOTE_CONTROL_AUTO_ACCEPT: 'true' },
        sandboxProvider: 'sandbox_runtime',
      }),
    ).toEqual([expect.stringContaining('REMOTE_CONTROL_AUTO_ACCEPT')]);
  });

  it('fails explicit remote mode without a control API key', () => {
    const failures = validateProductionSecurityGate({
      env: {
        GANTRY_SECURITY_POSTURE: 'remote',
        SECRET_ENCRYPTION_KEY: encryptionKey,
        GANTRY_IPC_AUTH_SECRET: strongIpcSecret,
      },
      sandboxProvider: 'sandbox_runtime',
    });

    expect(failures).toEqual([
      expect.stringContaining('GANTRY_CONTROL_API_KEYS_JSON'),
    ]);
  });

  it('passes production mode with strong key material', () => {
    expect(
      validateProductionSecurityGate({
        env: {
          NODE_ENV: 'production',
          SECRET_ENCRYPTION_KEY: encryptionKey,
          GANTRY_IPC_AUTH_SECRET: strongIpcSecret,
          GANTRY_CONTROL_API_KEYS_JSON: JSON.stringify([
            {
              kid: 'admin',
              token: strongToken,
              appId: 'default',
              scopes: ['sessions:read'],
            },
          ]),
        },
        sandboxProvider: 'sandbox_runtime',
      }),
    ).toEqual([]);
  });

  it('does not require sandbox_runtime for any posture (two-axis model)', () => {
    expect(
      validateProductionSecurityGate({
        env: {},
        sandboxProvider: 'direct',
      }),
    ).toEqual([]);

    expect(
      validateProductionSecurityGate({
        env: {
          NODE_ENV: 'production',
          SECRET_ENCRYPTION_KEY: encryptionKey,
          GANTRY_IPC_AUTH_SECRET: strongIpcSecret,
          GANTRY_CONTROL_API_KEYS_JSON: JSON.stringify([
            {
              kid: 'admin',
              token: strongToken,
              appId: 'default',
              scopes: ['sessions:read'],
            },
          ]),
        },
        sandboxProvider: 'direct',
      }),
    ).toEqual([]);
  });

  it('rejects keyrings that do not match the credential crypto contract', () => {
    const failures = validateProductionSecurityGate({
      env: {
        NODE_ENV: 'production',
        SECRET_ENCRYPTION_KEYRING_JSON: JSON.stringify({
          activeKeyId: 'primary',
          keys: { primary: encryptionKey },
        }),
        GANTRY_IPC_AUTH_SECRET: strongIpcSecret,
        GANTRY_CONTROL_API_KEYS_JSON: JSON.stringify([
          {
            kid: 'admin',
            token: strongToken,
            appId: 'default',
            scopes: ['sessions:read'],
          },
        ]),
      },
      sandboxProvider: 'sandbox_runtime',
    });

    expect(failures).toEqual([
      expect.stringContaining('SECRET_ENCRYPTION_KEY'),
    ]);
  });

  it('rejects an invalid configured keyring even when the direct key is valid', () => {
    const failures = validateProductionSecurityGate({
      env: {
        NODE_ENV: 'production',
        SECRET_ENCRYPTION_KEY: encryptionKey,
        SECRET_ENCRYPTION_KEYRING_JSON: JSON.stringify({
          active: 'missing',
          keys: { primary: encryptionKey },
        }),
        GANTRY_IPC_AUTH_SECRET: strongIpcSecret,
        GANTRY_CONTROL_API_KEYS_JSON: JSON.stringify([
          {
            kid: 'admin',
            token: strongToken,
            appId: 'default',
            scopes: ['sessions:read'],
          },
        ]),
      },
      sandboxProvider: 'sandbox_runtime',
    });

    expect(failures).toEqual([
      expect.stringContaining('SECRET_ENCRYPTION_KEY'),
    ]);
  });

  it('rejects keyrings with malformed inactive rotation keys', () => {
    const failures = validateProductionSecurityGate({
      env: {
        NODE_ENV: 'production',
        SECRET_ENCRYPTION_KEY: encryptionKey,
        SECRET_ENCRYPTION_KEYRING_JSON: JSON.stringify({
          active: 'primary',
          keys: {
            primary: encryptionKey,
            stale: Buffer.alloc(16, 2).toString('base64'),
          },
        }),
        GANTRY_IPC_AUTH_SECRET: strongIpcSecret,
        GANTRY_CONTROL_API_KEYS_JSON: JSON.stringify([
          {
            kid: 'admin',
            token: strongToken,
            appId: 'default',
            scopes: ['sessions:read'],
          },
        ]),
      },
      sandboxProvider: 'sandbox_runtime',
    });

    expect(failures).toEqual([
      expect.stringContaining('SECRET_ENCRYPTION_KEY'),
    ]);
  });

  it('rejects weak production IPC secrets and repeated control tokens', () => {
    const failures = validateProductionSecurityGate({
      env: {
        NODE_ENV: 'production',
        SECRET_ENCRYPTION_KEY: encryptionKey,
        GANTRY_IPC_AUTH_SECRET: 'ipc-secret',
        GANTRY_CONTROL_API_KEYS_JSON: JSON.stringify([
          {
            kid: 'admin',
            token: 'x'.repeat(32),
            appId: 'default',
            scopes: ['sessions:read'],
          },
        ]),
      },
      sandboxProvider: 'sandbox_runtime',
    });

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GANTRY_IPC_AUTH_SECRET'),
        expect.stringContaining('token must be at least 32 characters'),
      ]),
    );
  });

  it('rejects low-entropy encryption keys and keyring entries', () => {
    const repeatedKey = Buffer.alloc(32, 7).toString('base64');
    const baseEnv = {
      NODE_ENV: 'production',
      GANTRY_IPC_AUTH_SECRET: strongIpcSecret,
      GANTRY_CONTROL_API_KEYS_JSON: JSON.stringify([
        {
          kid: 'admin',
          token: strongToken,
          appId: 'default',
          scopes: ['sessions:read'],
        },
      ]),
    };

    expect(
      validateProductionSecurityGate({
        env: { ...baseEnv, SECRET_ENCRYPTION_KEY: repeatedKey },
        sandboxProvider: 'sandbox_runtime',
      }),
    ).toEqual([expect.stringContaining('SECRET_ENCRYPTION_KEY')]);

    expect(
      validateProductionSecurityGate({
        env: {
          ...baseEnv,
          SECRET_ENCRYPTION_KEYRING_JSON: JSON.stringify({
            active: 'primary',
            keys: {
              primary: encryptionKey,
              stale: repeatedKey,
            },
          }),
        },
        sandboxProvider: 'sandbox_runtime',
      }),
    ).toEqual([expect.stringContaining('SECRET_ENCRYPTION_KEY')]);
  });
});

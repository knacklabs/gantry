import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-preflight-'),
  );
  fs.writeFileSync(
    path.join(runtimeHome, '.env'),
    [
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'ONECLI_DATABASE_URL=postgres://onecli_app:pass@localhost:15432/myclaw?schema=onecli',
      'SECRET_ENCRYPTION_KEY=123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(runtimeHome, 'settings.yaml'),
    [
      'channels:',
      '  telegram:',
      '    enabled: false',
      '    sender_allowlist:',
      '      default:',
      '        allow: "*"',
      '        mode: trigger',
      '      agents: {}',
      '      log_denied: true',
      '    control_allowlist:',
      '      default: []',
      '      agents: {}',
      '  slack:',
      '    enabled: false',
      '    sender_allowlist:',
      '      default:',
      '        allow: "*"',
      '        mode: trigger',
      '      agents: {}',
      '      log_denied: true',
      '    control_allowlist:',
      '      default: []',
      '      agents: {}',
      'storage:',
      '  postgres:',
      '    url_env: MYCLAW_DATABASE_URL',
      '    schema: myclaw',
      'credential_broker:',
      '  mode: onecli',
      '  onecli:',
      '    url: http://localhost:10254',
      '    postgres:',
      '      url_env: ONECLI_DATABASE_URL',
      '      schema: onecli',
      '  external:',
      '    base_url: ""',
      'memory:',
      '  enabled: true',
      '  embeddings:',
      '    enabled: false',
      '    provider: disabled',
      '    model: text-embedding-3-large',
      '  dreaming:',
      '    enabled: false',
      '  llm:',
      '    models:',
      '      extractor: claude-haiku-4-5-20251001',
      '      dreaming: claude-sonnet-4-6',
      '      consolidation: claude-sonnet-4-6',
      '',
    ].join('\n'),
  );
  return runtimeHome;
}

function setCredentialBrokerSettings(
  runtimeHome: string,
  mode: 'none' | 'onecli' | 'external',
  externalBaseUrl = '',
): void {
  const settingsPath = path.join(runtimeHome, 'settings.yaml');
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  fs.writeFileSync(
    settingsPath,
    raw
      .replace('  mode: onecli', `  mode: ${mode}`)
      .replace(
        '  external:\n    base_url: ""',
        `  external:\n    base_url: ${externalBaseUrl ? externalBaseUrl : '""'}`,
      ),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runtime preflight', () => {
  it('passes when storage and OneCLI persistence readiness pass', async () => {
    const runtimeHome = makeRuntimeHome();
    const inspectRuntimeStorageReadiness = vi.fn(async () => ({
      status: 'pass',
      message: 'Postgres is ready.',
    }));
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness,
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness: vi.fn(async () => ({
            status: 'pass',
            message: 'OneCLI persistence is ready.',
          })),
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
    expect(inspectRuntimeStorageReadiness).toHaveBeenCalledWith(runtimeHome, {
      migrate: true,
    });
  });

  it('fails on storage readiness before probing OneCLI persistence', async () => {
    const runtimeHome = makeRuntimeHome();
    const inspectOnecliPersistenceReadiness = vi.fn();
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'fail',
        message: 'pgvector extension is missing.',
        details: ['vector=false'],
        nextAction: 'Enable pgvector.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness,
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('pgvector');
    expect(result.failure?.details.join('\n')).toContain('Enable pgvector');
    expect(inspectOnecliPersistenceReadiness).not.toHaveBeenCalled();
  });

  it('fails start readiness when OneCLI persistence isolation fails', async () => {
    const runtimeHome = makeRuntimeHome();
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness: vi.fn(async () => ({
            status: 'fail',
            message:
              'OneCLI database role can access the MyClaw runtime schema.',
            details: ['current_user=onecli_app'],
            nextAction: 'Revoke MyClaw schema privileges.',
          })),
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('OneCLI database role');
    expect(result.failure?.details.join('\n')).toContain(
      'Revoke MyClaw schema privileges',
    );
  });

  it('allows none credential mode without OneCLI runtime secrets', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    setCredentialBrokerSettings(runtimeHome, 'none');
    const inspectOnecliPersistenceReadiness = vi.fn();
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness,
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
    expect(inspectOnecliPersistenceReadiness).not.toHaveBeenCalled();
  });

  it('fails when runtime .env contains agent credentials', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.appendFileSync(
      path.join(runtimeHome, '.env'),
      'ANTHROPIC_API_KEY=sk-ant\n',
    );
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'ANTHROPIC_API_KEY is an agent-accessed credential',
    );
  });

  it('fails when runtime .env contains non-secret credential config', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.appendFileSync(
      path.join(runtimeHome, '.env'),
      'MYCLAW_CREDENTIAL_MODE=none\n',
    );
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'MYCLAW_CREDENTIAL_MODE is non-secret configuration',
    );
  });

  it('fails when runtime .env contains settings-owned default model', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.appendFileSync(
      path.join(runtimeHome, '.env'),
      'ANTHROPIC_MODEL=sonnet\n',
    );
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'ANTHROPIC_MODEL is non-secret configuration',
    );
    expect(result.failure?.details.join('\n')).toContain(
      'settings.yaml agent.default_model',
    );
  });

  it('ignores stale invalid OneCLI vars outside onecli credential mode', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        'ONECLI_DATABASE_URL=not-a-postgres-url',
        'SECRET_ENCRYPTION_KEY=short',
        '',
      ].join('\n'),
    );
    setCredentialBrokerSettings(
      runtimeHome,
      'external',
      'https://broker.example.com/anthropic',
    );
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails external credential mode preflight when broker endpoint is missing', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    setCredentialBrokerSettings(runtimeHome, 'external');
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'credential_broker.external.base_url',
    );
  });

  it('fails external credential mode preflight when broker endpoint is unsafe', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    setCredentialBrokerSettings(
      runtimeHome,
      'external',
      'https://user:pass@broker.example.com',
    );
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'embedded credentials',
    );
  });

  it('allows external credential mode preflight without probing broker reachability', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    setCredentialBrokerSettings(
      runtimeHome,
      'external',
      'https://broker.example.com/anthropic',
    );
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fail external credential mode preflight on broker HTTP method semantics', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    setCredentialBrokerSettings(
      runtimeHome,
      'external',
      'https://broker.example.com/anthropic',
    );
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    const fetchSpy = vi.fn(async () => new Response(null, { status: 405 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows enabled channels to read credentials from process env', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    setCredentialBrokerSettings(runtimeHome, 'none');
    const settingsPath = path.join(runtimeHome, 'settings.yaml');
    fs.writeFileSync(
      settingsPath,
      fs
        .readFileSync(settingsPath, 'utf-8')
        .replace(
          '  telegram:\n    enabled: false',
          '  telegram:\n    enabled: true',
        ),
    );
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'process-token');
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
  });

  it('fails when process env contains settings-owned credential mode', async () => {
    const runtimeHome = makeRuntimeHome();
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'none');
    const inspectOnecliPersistenceReadiness = vi.fn(async () => ({
      status: 'pass',
      message: 'OneCLI persistence is ready.',
    }));
    vi.doMock('@core/adapters/storage/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness,
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'MYCLAW_CREDENTIAL_MODE is non-secret configuration',
    );
    expect(result.failure?.details.join('\n')).toContain(
      'the process environment',
    );
    expect(inspectOnecliPersistenceReadiness).not.toHaveBeenCalled();
  });
});

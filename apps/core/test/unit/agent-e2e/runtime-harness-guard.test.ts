// Matrix §1 "Harness refuses to run against ~/gantry or live DB (isolation
// guard)". The guard is a pure function so the refusal contract is provable
// without booting anything.

import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertIsolatedRuntimeTarget,
  realRuntimeHome,
  startRuntimeHarness,
} from '../../agent-e2e/harness/runtime-harness.js';

const SAFE_DB_URL = 'postgres://user:pass@127.0.0.1:5432/gantry_e2e_abc123';
const SAFE_HOME = path.join(os.tmpdir(), 'gantry-agent-e2e-guard-test');

describe('agent-e2e runtime harness isolation guard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts a disposable home + per-run database', () => {
    expect(() =>
      assertIsolatedRuntimeTarget({
        runtimeHome: SAFE_HOME,
        databaseUrl: SAFE_DB_URL,
      }),
    ).not.toThrow();
  });

  it('refuses the real runtime home', () => {
    expect(() =>
      assertIsolatedRuntimeTarget({
        runtimeHome: realRuntimeHome(),
        databaseUrl: SAFE_DB_URL,
      }),
    ).toThrow(/live runtime home/);
  });

  it('refuses the real runtime home via an unnormalized path', () => {
    expect(() =>
      assertIsolatedRuntimeTarget({
        runtimeHome: path.join(os.homedir(), 'gantry', '..', 'gantry'),
        databaseUrl: SAFE_DB_URL,
      }),
    ).toThrow(/live runtime home/);
  });

  it('refuses the live `gantry` database on any host', () => {
    for (const url of [
      'postgres://user:pass@127.0.0.1:5432/gantry',
      'postgresql://user:pass@db.internal:5432/gantry?sslmode=require',
    ]) {
      expect(() =>
        assertIsolatedRuntimeTarget({
          runtimeHome: SAFE_HOME,
          databaseUrl: url,
        }),
      ).toThrow(/live `gantry` database/);
    }
  });

  it('refuses an unparseable database URL', () => {
    expect(() =>
      assertIsolatedRuntimeTarget({
        runtimeHome: SAFE_HOME,
        databaseUrl: 'not a url',
      }),
    ).toThrow(/not a valid URL/);
  });

  it('refuses the real runtime home through harness startup before spawning', async () => {
    vi.stubEnv('GANTRY_TEST_DATABASE_URL', SAFE_DB_URL);

    await expect(
      startRuntimeHarness({ runtimeHome: realRuntimeHome() }),
    ).rejects.toThrow(/live runtime home/);
  });

  it('refuses the live database through harness startup before spawning', async () => {
    vi.stubEnv(
      'GANTRY_TEST_DATABASE_URL',
      'postgres://user:pass@127.0.0.1:5432/gantry',
    );

    await expect(
      startRuntimeHarness({ runtimeHome: SAFE_HOME }),
    ).rejects.toThrow(/live `gantry` database/);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-storage-step-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

async function loadStorageStepWithPrompts(responses: unknown[]) {
  const select = vi.fn(async () => responses.shift());
  const text = vi.fn(async () => responses.shift());
  const note = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    select,
    text,
    note,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
  }));
  const { runStorageStep } = await import('@core/cli/setup-flow-core-steps.js');
  const { restoreDraft } = await import('@core/cli/setup-flow-state.js');
  return { runStorageStep, restoreDraft, text };
}

describe('setup storage step', () => {
  it('collects one Gantry database URL without provisioning Docker', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runStorageStep, restoreDraft, text } =
      await loadStorageStepWithPrompts([
        'local',
        'postgres://gantry_app:pass@localhost:5432/gantry',
        'gantry',
      ]);
    const draft = restoreDraft(runtimeHome, null);

    const action = await runStorageStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.postgresSetupKind).toBe('local');
    expect(draft.postgresDatabaseUrl).toBe(
      'postgres://gantry_app:pass@localhost:5432/gantry',
    );
    expect(draft.postgresSchema).toBe('gantry');
    expect(text).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(runtimeHome, '.env'))).toBe(false);
  });

  it('requires SSL for hosted Postgres URLs', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runStorageStep, restoreDraft } = await loadStorageStepWithPrompts([
      'hosted',
      'postgres://user:pass@db.example.com:5432/gantry',
    ]);
    const draft = restoreDraft(runtimeHome, null);

    await expect(runStorageStep(draft)).rejects.toThrow(/sslmode=require/);
  });

  it('allows localhost for the existing Postgres expert path', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runStorageStep, restoreDraft } = await loadStorageStepWithPrompts([
      'existing',
      'postgres://user:pass@localhost:5432/gantry',
      'custom_schema',
    ]);
    const draft = restoreDraft(runtimeHome, null);

    const action = await runStorageStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.postgresSetupKind).toBe('existing');
    expect(draft.postgresDatabaseUrl).toBe(
      'postgres://user:pass@localhost:5432/gantry',
    );
    expect(draft.postgresSchema).toBe('custom_schema');
  });
});

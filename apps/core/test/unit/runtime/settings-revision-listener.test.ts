import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SettingsRevision,
  SettingsRevisionRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import type { SettingsRevisionWakeupSource } from '@core/config/settings/settings-revision-notify.js';

const applied: number[] = [];
const importSettings = vi.hoisted(() => vi.fn());
const leaseState = vi.hoisted(() => {
  let held = false;
  const tryAcquire = vi.fn(async () => {
    if (held) return undefined;
    held = true;
    return {
      release: async () => {
        held = false;
      },
    };
  });
  return {
    reset: () => {
      held = false;
    },
    tryAcquire,
  };
});

vi.mock('@core/config/settings/settings-import-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/config/settings/settings-import-service.js')
  >('@core/config/settings/settings-import-service.js');
  return {
    ...actual,
    importWorkstationSettings: importSettings,
    settingsFromRevisionDocument: vi.fn(
      (document: Record<string, unknown>) => document as never,
    ),
  };
});

const loadState = vi.hoisted(() => ({ markSettingsLoaded: vi.fn() }));
vi.mock('@core/runtime/settings-load-state.js', () => ({
  markSettingsLoaded: loadState.markSettingsLoaded,
  markSettingsNotLoaded: vi.fn(),
  areSettingsLoaded: () => true,
}));

import { SettingsRevisionListener } from '@core/runtime/settings-revision-listener.js';

class FakeWakeupSource implements SettingsRevisionWakeupSource {
  listener: (() => void) | null = null;
  closed = false;
  subscribe(listener: () => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  emit(): void {
    this.listener?.();
  }
}

function makeRepo(rows: SettingsRevision[]): SettingsRevisionRepository {
  return {
    appendSettingsRevision: async () => ({
      status: 'appended' as const,
      revision: rows[rows.length - 1]!,
    }),
    getLatestSettingsRevision: async () => rows.at(-1) ?? null,
    getSettingsRevision: async () => null,
    listRecentSettingsRevisions: async () => rows,
  };
}

function revision(
  revisionNumber: number,
  minReaderVersion: number,
): SettingsRevision {
  return {
    appId: 'default',
    revision: revisionNumber,
    settingsDocument: { revision: revisionNumber },
    minReaderVersion,
    createdBy: 'test',
    note: null,
    createdAt: new Date().toISOString(),
  };
}

function makeListener(
  repo: SettingsRevisionRepository,
  wakeup: FakeWakeupSource,
  overrides: Partial<{
    readerVersion: number;
    onSkewAlert: (alert: unknown) => void;
    onFirstRevisionApplied: () => Promise<void> | void;
  }> = {},
) {
  return new SettingsRevisionListener({
    appId: 'default' as never,
    runtimeHome: '/tmp/gantry-listener-test',
    settingsRevisions: repo,
    leases: { tryAcquire: leaseState.tryAcquire },
    ops: {} as never,
    repositories: {} as never,
    wakeupSource: wakeup,
    reloadRuntimeState: async () => {},
    readerVersion: overrides.readerVersion ?? 1,
    onSkewAlert: overrides.onSkewAlert,
    onFirstRevisionApplied: overrides.onFirstRevisionApplied,
    // Never auto-fire the interval; tests drive passes explicitly.
    setIntervalFn: (() => 0 as never) as typeof setInterval,
    clearIntervalFn: (() => {}) as typeof clearInterval,
  });
}

describe('SettingsRevisionListener', () => {
  beforeEach(() => {
    applied.length = 0;
    leaseState.reset();
    leaseState.tryAcquire.mockClear();
    importSettings.mockReset();
    importSettings.mockImplementation(
      async (_deps: unknown, settings: { revision?: number }) => {
        applied.push(settings.revision ?? -1);
      },
    );
  });

  it('applies a new revision and marks settings loaded on first apply', async () => {
    applied.length = 0;
    loadState.markSettingsLoaded.mockClear();
    const wakeup = new FakeWakeupSource();
    const listener = makeListener(makeRepo([revision(1, 1)]), wakeup);

    const result = await listener.applyLatest();

    expect(result).toEqual({ result: 'applied', revision: 1 });
    expect(applied).toHaveLength(1);
    expect(loadState.markSettingsLoaded).toHaveBeenCalledOnce();
    expect(listener.getAppliedRevision()).toBe(1);
  });

  it('holds the last-applied revision and alerts on reader-version skew', async () => {
    applied.length = 0;
    const wakeup = new FakeWakeupSource();
    const onSkewAlert = vi.fn();
    const listener = makeListener(makeRepo([revision(5, 2)]), wakeup, {
      readerVersion: 1,
      onSkewAlert,
    });

    const result = await listener.applyLatest();

    expect(result).toEqual({ result: 'held', revision: 5 });
    expect(applied).toHaveLength(0);
    expect(onSkewAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 5,
        minReaderVersion: 2,
        readerVersion: 1,
      }),
    );
    expect(listener.getAppliedRevision()).toBe(0);
  });

  it('fires onFirstRevisionApplied exactly once, on the first apply only', async () => {
    applied.length = 0;
    const rows = [revision(1, 1)];
    const onFirstRevisionApplied = vi.fn();
    const listener = makeListener(makeRepo(rows), new FakeWakeupSource(), {
      onFirstRevisionApplied,
    });

    await listener.applyLatest();
    expect(onFirstRevisionApplied).toHaveBeenCalledOnce();

    rows.push(revision(2, 1));
    await listener.applyLatest();
    expect(onFirstRevisionApplied).toHaveBeenCalledOnce();
  });

  it('does not fire onFirstRevisionApplied on a skew hold', async () => {
    applied.length = 0;
    const onFirstRevisionApplied = vi.fn();
    const listener = makeListener(
      makeRepo([revision(5, 2)]),
      new FakeWakeupSource(),
      { readerVersion: 1, onFirstRevisionApplied },
    );

    const result = await listener.applyLatest();

    expect(result).toEqual({ result: 'held', revision: 5 });
    expect(onFirstRevisionApplied).not.toHaveBeenCalled();
  });

  it('keeps the applied revision when the first-revision hook throws', async () => {
    applied.length = 0;
    const warn = vi.fn();
    const listener = new SettingsRevisionListener({
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-listener-test',
      settingsRevisions: makeRepo([revision(1, 1)]),
      leases: { tryAcquire: leaseState.tryAcquire },
      ops: {} as never,
      repositories: {} as never,
      wakeupSource: new FakeWakeupSource(),
      reloadRuntimeState: async () => {},
      readerVersion: 1,
      onFirstRevisionApplied: () => {
        throw new Error('held service failed to start');
      },
      logWarn: warn,
      setIntervalFn: (() => 0 as never) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    const result = await listener.applyLatest();

    expect(result).toEqual({ result: 'applied', revision: 1 });
    expect(listener.getAppliedRevision()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1 }),
      expect.stringContaining('First-revision start hook failed'),
    );
  });

  it('recovers a dropped NOTIFY via a subsequent poll pass', async () => {
    applied.length = 0;
    const rows = [revision(1, 1)];
    const repo = makeRepo(rows);
    const wakeup = new FakeWakeupSource();
    const listener = makeListener(repo, wakeup);

    await listener.applyLatest();
    expect(listener.getAppliedRevision()).toBe(1);

    // A new revision lands but its NOTIFY is dropped (no emit). The poll pass
    // still converges to revision 2.
    rows.push(revision(2, 1));
    const result = await listener.applyLatest();

    expect(result).toEqual({ result: 'applied', revision: 2 });
    expect(listener.getAppliedRevision()).toBe(2);
  });

  it('serializes concurrent projectors for the same app', async () => {
    let activeApplies = 0;
    let maxActiveApplies = 0;
    importSettings.mockImplementation(async () => {
      activeApplies += 1;
      maxActiveApplies = Math.max(maxActiveApplies, activeApplies);
      await new Promise((resolve) => setImmediate(resolve));
      activeApplies -= 1;
    });
    const repo = makeRepo([revision(1, 1)]);
    const first = makeListener(repo, new FakeWakeupSource());
    const second = makeListener(repo, new FakeWakeupSource());

    await Promise.all([first.applyLatest(), second.applyLatest()]);

    expect(maxActiveApplies).toBe(1);
    expect(leaseState.tryAcquire).toHaveBeenCalledWith(
      'settings-projector:default',
    );
  });

  it('skips a stale target and applies the current head under the lease', async () => {
    const target = revision(10, 1);
    const head = revision(11, 1);
    const repo = makeRepo([target]);
    repo.getLatestSettingsRevision = vi
      .fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(head);
    const listener = makeListener(repo, new FakeWakeupSource());

    const result = await listener.applyLatest();

    expect(result).toEqual({ result: 'applied', revision: 11 });
    expect(applied).toEqual([11]);
    expect(listener.getAppliedRevision()).toBe(11);
  });

  it('is a no-op when the latest revision is already applied', async () => {
    applied.length = 0;
    const listener = makeListener(
      makeRepo([revision(3, 1)]),
      new FakeWakeupSource(),
    );
    await listener.applyLatest();
    applied.length = 0;
    const result = await listener.applyLatest();
    expect(result).toEqual({ result: 'unchanged' });
    expect(applied).toHaveLength(0);
  });

  it('closes the wakeup source on stop', async () => {
    const wakeup = new FakeWakeupSource();
    const listener = makeListener(makeRepo([revision(1, 1)]), wakeup);
    listener.start();
    await listener.stop();
    expect(wakeup.closed).toBe(true);
  });
});

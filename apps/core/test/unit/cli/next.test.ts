import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockNextAction = vi.hoisted(() => ({
  value: { kind: 'none', label: 'none' } as { kind: string; label: string },
}));

// @clack/prompts: capture log/note calls without touching a TTY.
const clack = vi.hoisted(() => ({
  info: vi.fn(),
  note: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  log: {
    info: clack.info,
    success: clack.success,
    error: clack.error,
    warn: clack.warn,
  },
  note: clack.note,
  confirm: vi.fn(async () => true),
  isCancel: vi.fn(() => false),
  outro: vi.fn(),
}));

// Force the storage path to throw so resolveCurrentGuidedAction falls into its
// settings-only fallback, where the nextAction comes from the mocked builder.
vi.mock('@core/adapters/storage/postgres/factory.js', () => ({
  createStorageRuntime: vi.fn(() => {
    throw new Error('storage offline in test');
  }),
}));

vi.mock(
  '@core/application/control-plane/control-plane-storage-model.js',
  () => ({
    buildControlPlaneReadModelFromRepositories: vi.fn(async () => ({
      nextAction: mockNextAction.value,
    })),
  }),
);

vi.mock('@core/application/control-plane/control-plane-read-model.js', () => ({
  buildControlPlaneReadModelFromSettings: vi.fn(() => ({
    nextAction: mockNextAction.value,
  })),
}));

vi.mock(
  '@core/application/control-plane/control-plane-settings-inputs.js',
  () => ({
    controlPlaneProviderInputs: vi.fn(() => []),
    controlPlaneMemoryStatus: vi.fn(() => 'Disabled'),
  }),
);

const runDoctorWithNetwork = vi.hoisted(() => vi.fn());
vi.mock('@core/cli/doctor.js', () => ({
  runDoctorWithNetwork,
}));

import { runNextCommand } from '@core/cli/next.js';

const settings = { memory: { enabled: false } } as never;
const restartRuntime = vi.fn(() => ({ ok: true, message: 'restarted' }));

beforeEach(() => {
  vi.clearAllMocks();
  mockNextAction.value = { kind: 'none', label: 'none' };
  restartRuntime.mockReturnValue({ ok: true, message: 'restarted' });
});

afterEach(() => {
  delete process.env.GANTRY_HOME;
});

describe('runNextCommand', () => {
  it('logs and returns 0 when the resolved action is none', async () => {
    mockNextAction.value = { kind: 'none', label: 'none' };

    const code = await runNextCommand(
      'file:///test',
      '/tmp/gantry-next',
      [],
      settings,
      restartRuntime,
    );

    expect(code).toBe(0);
    expect(clack.info).toHaveBeenCalledWith(
      'No next action. Everything looks ready.',
    );
    expect(clack.note).not.toHaveBeenCalled();
  });

  it('shows a preview and returns 0 without executing when --run is absent', async () => {
    mockNextAction.value = {
      kind: 'runtime_blocked',
      label: 'Run gantry doctor and fix blocking runtime checks.',
    };

    const code = await runNextCommand(
      'file:///test',
      '/tmp/gantry-next',
      [],
      settings,
      restartRuntime,
    );

    expect(code).toBe(0);
    // Preview rendered, no executor invoked.
    expect(clack.note).toHaveBeenCalledTimes(1);
    expect(clack.note.mock.calls[0]?.[1]).toBe('Next action');
    expect(runDoctorWithNetwork).not.toHaveBeenCalled();
    expect(restartRuntime).not.toHaveBeenCalled();
    expect(clack.success).not.toHaveBeenCalled();
  });
});

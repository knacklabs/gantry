import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  deleteJob: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  isCancel: vi.fn(() => false),
  log: {
    error: state.error,
    info: state.info,
    success: state.success,
    warn: state.warn,
  },
  note: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@core/cli/group-helpers.js', () => ({
  isInteractiveTerminal: vi.fn(() => false),
  loadDatabase: vi.fn(async () => ({
    close: state.close,
    deleteJob: state.deleteJob,
  })),
}));

import { runJobsCommand } from '@core/cli/jobs.js';

beforeEach(() => {
  state.deleteJob.mockClear();
  state.close.mockClear();
  state.error.mockClear();
  state.info.mockClear();
  state.success.mockClear();
  state.warn.mockClear();
});

describe('gantry jobs delete', () => {
  it('requires --yes in non-interactive mode, then deletes system dreaming jobs with a re-seed warning', async () => {
    const jobId = 'system:dreaming:shared:tg:123';

    expect(await runJobsCommand('/tmp/gantry-jobs', ['delete', jobId])).toBe(1);
    expect(state.deleteJob).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(
      'Refusing destructive deletion in non-interactive mode without --yes.',
    );

    expect(
      await runJobsCommand('/tmp/gantry-jobs', ['delete', jobId, '--yes']),
    ).toBe(0);
    expect(state.deleteJob).toHaveBeenCalledWith(jobId);
    expect(state.warn).toHaveBeenCalledWith(
      expect.stringContaining('re-seeded from conversation routes'),
    );
    expect(state.close).toHaveBeenCalled();
  });
});

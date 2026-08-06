import { describe, expect, it } from 'vitest';

import { resolveCallerResolvedRunId } from '@core/jobs/ipc-caller-resolved-tool-handler.js';

describe('caller-resolved tool run correlation', () => {
  it('uses the signed request run id when present', () => {
    expect(
      resolveCallerResolvedRunId({
        runId: 'run-direct',
        parentTaskId: 'task-child',
        sandboxRunId: 'run-policy',
      }),
    ).toBe('run-direct');
  });

  it('inherits the host policy run only for a delegated child', () => {
    expect(
      resolveCallerResolvedRunId({
        parentTaskId: 'task-child',
        sandboxRunId: 'run-policy',
      }),
    ).toBe('run-policy');
    expect(
      resolveCallerResolvedRunId({ sandboxRunId: 'run-policy' }),
    ).toBeUndefined();
  });

  it('falls back to the durable parent task run only for a delegated child', () => {
    expect(
      resolveCallerResolvedRunId({
        parentTaskId: 'task-child',
        parentTaskRunId: 'run-parent',
      }),
    ).toBe('run-parent');
    expect(
      resolveCallerResolvedRunId({ parentTaskRunId: 'run-parent' }),
    ).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskContext, TaskIpcData } from '@core/jobs/ipc-types.js';
import {
  registerPermissionRunRestriction,
  unregisterPermissionRunRestriction,
} from '@core/runtime/permission-decision-coordinator.js';

const mocks = vi.hoisted(() => ({
  reject: vi.fn(),
}));

vi.mock('@core/jobs/ipc-shared.js', () => ({
  createTaskResponder: () => ({
    accept: vi.fn(),
    acceptData: vi.fn(),
    reject: mocks.reject,
  }),
}));

import { schedulerCreateTaskHandlers } from '@core/jobs/ipc-scheduler-create-handlers.js';
import { schedulerMutateTaskHandlers } from '@core/jobs/ipc-scheduler-mutate-handlers.js';

const mutationHandlers = {
  ...schedulerCreateTaskHandlers,
  ...schedulerMutateTaskHandlers,
};

function context(data: TaskIpcData): TaskContext {
  return {
    data: {
      taskId: `task-${data.type}`,
      chatJid: 'tg:team',
      ...data,
    },
    sourceAgentFolder: 'team',
    conversationBindings: {},
    sourceAgentFolderJids: [],
    deps: {},
  } as TaskContext;
}

describe('scheduler mutation authority', () => {
  afterEach(() => {
    mocks.reject.mockReset();
    unregisterPermissionRunRestriction({
      sourceAgentFolder: 'team',
      responseKeyId: 'scheduled-key',
    });
  });

  it('host rejects mutations from scheduled or unknown run sources', async () => {
    registerPermissionRunRestriction({
      sourceAgentFolder: 'team',
      responseKeyId: 'scheduled-key',
      hideAuthorityTools: false,
      runKind: 'scheduled',
      jobId: 'job-source',
      runId: 'run-source',
    });

    for (const [type, handler] of Object.entries(mutationHandlers)) {
      await handler(
        context({
          type,
          responseKeyId: 'scheduled-key',
          sourceJobId: 'job-source',
          sourceRunId: 'run-source',
          sourceRunKind: 'scheduled',
        }),
      );
      expect(mocks.reject).toHaveBeenLastCalledWith(
        'Scheduled runs cannot mutate scheduler jobs. Report a proposedJobChange instead.',
        'permission_denied',
      );
    }

    for (const [type, handler] of Object.entries(mutationHandlers)) {
      await handler(
        context({
          type,
          responseKeyId: 'unknown-key',
          sourceRunKind: 'interactive',
        }),
      );
      expect(mocks.reject).toHaveBeenLastCalledWith(
        'Scheduler mutation source could not be verified.',
        'permission_denied',
      );
    }

    expect(mocks.reject).toHaveBeenCalledTimes(
      Object.keys(mutationHandlers).length * 2,
    );
  });
});

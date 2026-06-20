import type { AsyncTaskRecord } from '../domain/ports/async-tasks.js';

export function cancelledReceipt(
  task: AsyncTaskRecord,
  childCancelledCount = 0,
) {
  return task.kind === 'delegated_agent'
    ? {
        completed: 'cancelled',
        used: 'Gantry agent run',
        changed: 'none',
        delegated: 'yes' as const,
        subtasks: `0 completed, 0 failed, ${Math.max(1, childCancelledCount)} cancelled`,
        needsAttention: 'none',
      }
    : {
        completed: 'cancelled',
        used: 'RunCommand',
        changed: 'none',
        delegated: 'no' as const,
        needsAttention: 'none',
      };
}

export function failedReceipt(task: AsyncTaskRecord, completed: string) {
  return task.kind === 'delegated_agent'
    ? {
        completed,
        used: 'Gantry agent run',
        changed: 'unknown',
        delegated: 'yes' as const,
        subtasks: '0 completed, 1 failed, 0 cancelled',
        needsAttention: 'start this task again if it is still needed',
      }
    : {
        completed,
        used: 'RunCommand',
        changed: 'unknown',
        delegated: 'no' as const,
        needsAttention: 'start this task again if it is still needed',
      };
}

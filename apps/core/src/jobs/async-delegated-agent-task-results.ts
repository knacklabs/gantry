import {
  type AsyncTaskRecord,
  type AsyncTaskStatusCount,
  toPublicAsyncTaskDto,
} from '../domain/ports/async-tasks.js';

export function activeChildCount(counts: AsyncTaskStatusCount[]): number {
  return counts.reduce(
    (total, entry) =>
      ['queued', 'running', 'needs_attention'].includes(entry.status)
        ? total + entry.count
        : total,
    0,
  );
}

function statusCount(
  counts: AsyncTaskStatusCount[],
  status: AsyncTaskRecord['status'],
): number {
  return counts.find((entry) => entry.status === status)?.count ?? 0;
}

export function childTaskResult(
  counts: AsyncTaskStatusCount[],
  terminalChildren: ReturnType<typeof toPublicAsyncTaskDto>[],
): {
  summary: string;
  hasFailure: boolean;
  terminalChildren: ReturnType<typeof toPublicAsyncTaskDto>[];
} {
  const completed = 1 + statusCount(counts, 'completed');
  const failed =
    statusCount(counts, 'failed') + statusCount(counts, 'timed_out');
  const cancelled = statusCount(counts, 'cancelled');
  return {
    summary: `${completed} completed, ${failed} failed, ${cancelled} cancelled`,
    hasFailure: failed > 0 || cancelled > 0,
    terminalChildren,
  };
}

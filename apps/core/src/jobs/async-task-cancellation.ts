import type {
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import { nowIso } from '../shared/time/datetime.js';
import { cancelledReceipt } from './async-command-task-receipts.js';

export async function refreshDelegatedCancellationReceipt(input: {
  repository: AsyncTaskRepository;
  parent: AsyncTaskRecord;
  alreadyCancelled: number;
  cancelChildTasks: (
    parent: AsyncTaskRecord,
  ) => Promise<
    { ok: true; cancelled: number } | { ok: false; message: string }
  >;
}): Promise<void> {
  const remaining = await input.cancelChildTasks(input.parent);
  if (!remaining.ok) return;
  const childCancelledCount = input.alreadyCancelled + remaining.cancelled;
  if (childCancelledCount === 0) return;
  await input.repository.updateTaskReceipt(
    input.parent.id,
    cancelledReceipt(input.parent, childCancelledCount),
    nowIso(),
  );
}

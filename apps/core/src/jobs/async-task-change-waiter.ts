import type { AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type {
  CoreDelegatedTaskCompletion,
  CoreDelegatedTaskCompletionSubscription,
} from '../application/core-tools/task-lifecycle.js';

export type AsyncTaskCompletionSubscription =
  CoreDelegatedTaskCompletionSubscription;

export type AsyncTaskCompletionStartResult =
  | {
      ok: true;
      task: import('../domain/ports/async-tasks.js').PublicAsyncTaskDto;
      completion: AsyncTaskCompletionSubscription;
    }
  | { ok: false; message: string };

export class AsyncTaskChangeWaiter {
  private readonly waiters = new Set<() => void>();
  private readonly completionWaiters = new Map<
    string,
    Set<(completion: CoreDelegatedTaskCompletion) => void>
  >();

  notify(): void {
    for (const wake of [...this.waiters]) {
      this.waiters.delete(wake);
      wake();
    }
  }

  wait(input: { signal: AbortSignal; timeoutMs: number }): Promise<void> {
    if (input.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let done = () => undefined;
      const timer = setTimeout(() => done(), input.timeoutMs);
      done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        input.signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      input.signal.addEventListener('abort', done, { once: true });
    });
  }

  subscribeCompletion(taskId: string): AsyncTaskCompletionSubscription {
    let resolveCompletion!: (completion: CoreDelegatedTaskCompletion) => void;
    const completion = new Promise<CoreDelegatedTaskCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const taskWaiters = this.completionWaiters.get(taskId) ?? new Set();
    taskWaiters.add(resolveCompletion);
    this.completionWaiters.set(taskId, taskWaiters);
    return {
      wait: (timeoutMs) =>
        new Promise((resolve) => {
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, timeoutMs);
          timer.unref?.();
          void completion.then((value) => {
            if (timedOut) return;
            clearTimeout(timer);
            resolve(value);
          });
        }),
    };
  }

  notifyCompletion(completion: CoreDelegatedTaskCompletion): void {
    this.notify();
    const waiters = this.completionWaiters.get(completion.taskId);
    if (!waiters) return;
    this.completionWaiters.delete(completion.taskId);
    for (const resolve of waiters) resolve(completion);
  }
}

const waitersByRepository = new WeakMap<
  AsyncTaskRepository,
  AsyncTaskChangeWaiter
>();

export function asyncTaskChangeWaiterFor(
  repository: AsyncTaskRepository,
): AsyncTaskChangeWaiter {
  let waiter = waitersByRepository.get(repository);
  if (!waiter) {
    waiter = new AsyncTaskChangeWaiter();
    waitersByRepository.set(repository, waiter);
  }
  return waiter;
}

export function notifyAsyncTaskChange(repository: AsyncTaskRepository): void {
  asyncTaskChangeWaiterFor(repository).notify();
}

export function subscribeAsyncTaskCompletion(
  repository: AsyncTaskRepository,
  taskId: string,
): AsyncTaskCompletionSubscription {
  return asyncTaskChangeWaiterFor(repository).subscribeCompletion(taskId);
}

export function notifyAsyncTaskCompletion(
  repository: AsyncTaskRepository,
  updated: unknown,
  taskId: string,
  input: {
    status: CoreDelegatedTaskCompletion['status'];
    output: string;
    error?: string;
  },
): void {
  if (!updated) return;
  asyncTaskChangeWaiterFor(repository).notifyCompletion({
    taskId,
    status: input.status,
    result: input.output,
    ...(input.error ? { error: input.error } : {}),
  });
}

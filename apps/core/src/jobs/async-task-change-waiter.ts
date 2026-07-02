import type { AsyncTaskRepository } from '../domain/ports/async-tasks.js';

export class AsyncTaskChangeWaiter {
  private readonly waiters = new Set<() => void>();

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

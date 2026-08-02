export class AsyncTaskChangeWaiter {
    waiters = new Set();
    completionWaiters = new Map();
    notify() {
        for (const wake of [...this.waiters]) {
            this.waiters.delete(wake);
            wake();
        }
    }
    wait(input) {
        if (input.signal.aborted)
            return Promise.resolve();
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
    subscribeCompletion(taskId) {
        let resolveCompletion;
        const completion = new Promise((resolve) => {
            resolveCompletion = resolve;
        });
        const taskWaiters = this.completionWaiters.get(taskId) ?? new Set();
        taskWaiters.add(resolveCompletion);
        this.completionWaiters.set(taskId, taskWaiters);
        return {
            wait: (timeoutMs) => new Promise((resolve) => {
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    resolve(null);
                }, timeoutMs);
                timer.unref?.();
                void completion.then((value) => {
                    if (timedOut)
                        return;
                    clearTimeout(timer);
                    resolve(value);
                });
            }),
        };
    }
    notifyCompletion(completion) {
        this.notify();
        const waiters = this.completionWaiters.get(completion.taskId);
        if (!waiters)
            return;
        this.completionWaiters.delete(completion.taskId);
        for (const resolve of waiters)
            resolve(completion);
    }
}
const waitersByRepository = new WeakMap();
export function asyncTaskChangeWaiterFor(repository) {
    let waiter = waitersByRepository.get(repository);
    if (!waiter) {
        waiter = new AsyncTaskChangeWaiter();
        waitersByRepository.set(repository, waiter);
    }
    return waiter;
}
export function notifyAsyncTaskChange(repository) {
    asyncTaskChangeWaiterFor(repository).notify();
}
export function subscribeAsyncTaskCompletion(repository, taskId) {
    return asyncTaskChangeWaiterFor(repository).subscribeCompletion(taskId);
}
export function notifyAsyncTaskCompletion(repository, updated, taskId, input) {
    if (!updated)
        return;
    asyncTaskChangeWaiterFor(repository).notifyCompletion({
        taskId,
        status: input.status,
        result: input.output,
        ...(input.error ? { error: input.error } : {}),
    });
}

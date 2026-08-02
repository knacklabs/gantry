export class AsyncTaskQueue {
    maxActive;
    maxPending;
    activeCount = 0;
    pending = [];
    pendingHead = 0;
    drainResolvers = [];
    slotResolvers = [];
    slotResolverHead = 0;
    constructor(maxActive, maxPending, _maxWaiting = maxPending) {
        this.maxActive = maxActive;
        this.maxPending = maxPending;
        void _maxWaiting;
    }
    enqueue(task) {
        if (this.size() >= this.maxPending)
            return false;
        this.pending.push(task);
        this.drain();
        return true;
    }
    async enqueueWhenAvailable(task) {
        while (!this.enqueue(task)) {
            await this.waitForSlot();
        }
        return true;
    }
    async waitForIdle(timeoutMs) {
        if (this.isIdle()) {
            return true;
        }
        const idle = new Promise((resolve) => this.drainResolvers.push(() => resolve(true)));
        if (typeof timeoutMs !== 'number')
            return idle;
        return Promise.race([
            idle,
            new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
    }
    size() {
        return this.activeCount + this.pending.length - this.pendingHead;
    }
    isIdle() {
        return this.activeCount === 0 && this.pendingHead >= this.pending.length;
    }
    drain() {
        while (this.activeCount < this.maxActive &&
            this.pendingHead < this.pending.length) {
            const task = this.pending[this.pendingHead];
            this.pendingHead += 1;
            if (this.pendingHead > 1024 &&
                this.pendingHead * 2 > this.pending.length) {
                this.pending.splice(0, this.pendingHead);
                this.pendingHead = 0;
            }
            this.activeCount += 1;
            task()
                .catch(() => {
                // Callers own task-level error reporting.
            })
                .finally(() => {
                this.activeCount -= 1;
                this.resolveNextSlotWaiterIfAvailable();
                this.resolveDrainIfIdle();
                this.drain();
            });
        }
    }
    resolveNextSlotWaiterIfAvailable() {
        if (this.size() >= this.maxPending)
            return;
        if (this.slotResolverHead >= this.slotResolvers.length)
            return;
        const resolve = this.slotResolvers[this.slotResolverHead];
        this.slotResolverHead += 1;
        if (this.slotResolverHead > 1024 &&
            this.slotResolverHead * 2 > this.slotResolvers.length) {
            this.slotResolvers.splice(0, this.slotResolverHead);
            this.slotResolverHead = 0;
        }
        resolve();
    }
    resolveDrainIfIdle() {
        if (!this.isIdle())
            return;
        this.pending.length = 0;
        this.pendingHead = 0;
        const resolvers = this.drainResolvers;
        this.drainResolvers = [];
        for (const resolve of resolvers)
            resolve();
    }
    waitForSlot() {
        if (this.size() < this.maxPending) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.slotResolvers.push(resolve);
        });
    }
}

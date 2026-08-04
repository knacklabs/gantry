export class StreamResetEpochs {
    byKey = new Map();
    next = 0;
    current(key) {
        const current = this.byKey.get(key);
        if (current !== undefined)
            return current;
        const created = ++this.next;
        this.byKey.set(key, created);
        return created;
    }
    guard(key, states) {
        const epoch = this.current(key);
        return (state, allowCompleted = false) => {
            const current = states.get(key);
            return (this.isCurrent(key, epoch) &&
                (current === state || (allowCompleted && current === undefined)));
        };
    }
    bump(key) {
        this.byKey.set(key, ++this.next);
    }
    bumpMatching(keys, prefix) {
        for (const key of keys)
            if (key.startsWith(prefix))
                this.bump(key);
    }
    isCurrent(key, epoch) {
        return this.byKey.get(key) === epoch;
    }
    prune(key) {
        this.byKey.delete(key);
    }
    deleteState(key, states) {
        states.delete(key);
        this.prune(key);
    }
    clear() {
        this.byKey.clear();
    }
}

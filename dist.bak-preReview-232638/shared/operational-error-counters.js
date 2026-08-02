const counters = new Map();
function counterKey(subsystem, kind) {
    return `${subsystem}:${kind}`;
}
export function incrementOperationalError(subsystem, kind) {
    const key = counterKey(subsystem, kind);
    const current = counters.get(key);
    if (current) {
        current.count += 1;
        return;
    }
    counters.set(key, { subsystem, kind, count: 1 });
}
export function getOperationalErrorCount(subsystem, kind) {
    return counters.get(counterKey(subsystem, kind))?.count ?? 0;
}
export function snapshotOperationalErrors() {
    return [...counters.values()];
}

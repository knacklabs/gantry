export function releaseIpcRootLock(input) {
    if (!input.lockPath)
        return false;
    try {
        input.runnerControlPort?.releaseRootLock(input.lockPath);
    }
    catch (err) {
        // prettier-ignore
        input.warn({ err, lockPath: input.lockPath }, 'Failed to release IPC lock');
    }
    return true;
}

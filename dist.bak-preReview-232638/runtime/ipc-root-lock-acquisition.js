import path from 'path';
export function acquireIpcRootLockForWatcher(input) {
    try {
        return input.runnerControlPort.acquireRootLock();
    }
    catch (err) {
        const lockPath = path.join(input.runnerControlPort.baseDir, '.lock');
        const code = err && typeof err === 'object' && 'code' in err
            ? String(err.code)
            : '';
        if (code !== 'EEXIST')
            throw err;
        const recoveredLock = input.runnerControlPort.recoverRootLock(lockPath);
        if (!recoveredLock.recovered) {
            input.warn({
                lockPath,
                holderPid: recoveredLock.pid,
                holderStartedAt: recoveredLock.startedAt,
                reason: recoveredLock.recoveryReason,
            }, 'IPC watcher lock already held, skipping start');
            return undefined;
        }
        input.warn({
            lockPath,
            holderPid: recoveredLock.pid,
            holderStartedAt: recoveredLock.startedAt,
            reason: recoveredLock.recoveryReason,
        }, 'Recovered stale IPC watcher lock; retrying start');
        try {
            return input.runnerControlPort.acquireRootLock();
        }
        catch (retryErr) {
            const retryCode = retryErr && typeof retryErr === 'object' && 'code' in retryErr
                ? String(retryErr.code)
                : '';
            if (retryCode !== 'EEXIST')
                throw retryErr;
            const retryDetails = input.runnerControlPort.readRootLock(lockPath);
            input.warn({
                lockPath,
                holderPid: retryDetails.pid,
                holderStartedAt: retryDetails.startedAt,
                reason: 'reacquire_raced',
            }, 'IPC watcher lock already held, skipping start');
            return undefined;
        }
    }
}

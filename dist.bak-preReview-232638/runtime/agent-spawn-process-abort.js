const RUN_ABORT_KILL_GRACE_MS = 5_000;
export function abortedRunnerOutput(runnerLabel, externalSessionId) {
    return {
        status: 'error',
        result: null,
        ...(externalSessionId ? { providerSession: { externalSessionId } } : {}),
        error: `${runnerLabel} stopped because the run was aborted`,
    };
}
export function bindRunnerAbortSignal(input) {
    let runnerClosed = false;
    let runAborted = false;
    let abortKillTimer;
    const terminate = () => {
        if (runnerClosed || runAborted)
            return;
        runAborted = true;
        input.warn(input.context, `${input.runnerLabel} run aborted, stopping`);
        const pid = input.runner.pid;
        if (typeof pid === 'number' && pid > 0) {
            try {
                process.kill(-pid, 'SIGTERM');
            }
            catch {
                input.runner.kill('SIGTERM');
            }
        }
        else {
            input.runner.kill('SIGTERM');
        }
        abortKillTimer = setTimeout(() => {
            if (!runnerClosed)
                input.runner.kill('SIGKILL');
        }, RUN_ABORT_KILL_GRACE_MS);
        abortKillTimer.unref?.();
    };
    if (input.signal?.aborted) {
        terminate();
    }
    else {
        input.signal?.addEventListener('abort', terminate, { once: true });
    }
    return {
        aborted: () => runAborted,
        close: () => {
            runnerClosed = true;
            if (abortKillTimer)
                clearTimeout(abortKillTimer);
            input.signal?.removeEventListener('abort', terminate);
        },
    };
}

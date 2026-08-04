export function remainingMemoryBudgetMs(request, nowMs) {
    return request.deadlineAtMs ? request.deadlineAtMs - nowMs() : undefined;
}
export function assertMemoryRequestNotExpired(request, nowMs) {
    const remainingMs = remainingMemoryBudgetMs(request, nowMs);
    if (remainingMs !== undefined && remainingMs <= 0) {
        throw new Error('memory IPC request expired');
    }
}
export function hasEnoughMemoryBudget(request, nowMs) {
    const remainingMs = remainingMemoryBudgetMs(request, nowMs);
    return remainingMs === undefined || remainingMs > MEMORY_DEADLINE_SAFETY_MS;
}
export async function runWithinMemoryDeadline(request, work, nowMs) {
    const controller = new AbortController();
    const remainingMs = remainingMemoryBudgetMs(request, nowMs);
    if (remainingMs === undefined) {
        return { status: 'completed', value: await work(controller.signal) };
    }
    const timeoutMs = remainingMs - MEMORY_DEADLINE_SAFETY_MS;
    if (timeoutMs <= 0)
        return { status: 'deadline_exceeded' };
    let timeout;
    const workPromise = work(controller.signal, timeoutMs);
    try {
        return await Promise.race([
            workPromise.then((value) => ({ status: 'completed', value })),
            new Promise((resolve) => {
                timeout = setTimeout(() => {
                    controller.abort(new Error('memory IPC deadline exceeded'));
                    resolve({ status: 'deadline_exceeded' });
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
        workPromise.catch(() => undefined);
    }
}
export function deadlineUnavailableResponse(request, provider) {
    return {
        ok: true,
        requestId: request.requestId,
        provider,
        data: {
            status: 'unavailable',
            unavailable_reason: 'deadline_exceeded',
        },
    };
}
const MEMORY_DEADLINE_SAFETY_MS = 1_000;

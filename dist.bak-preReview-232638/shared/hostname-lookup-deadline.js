export async function lookupHostnameWithDeadline(input) {
    if (input.signal?.aborted) {
        throw abortError();
    }
    let timeout;
    let onAbort;
    const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            reject(new Error(input.timeoutMessage));
        }, input.timeoutMs);
        timeout.unref?.();
        onAbort = () => reject(abortError());
        input.signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([input.lookupHostname(input.hostname), deadline]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
        if (onAbort)
            input.signal?.removeEventListener('abort', onAbort);
    }
}
function abortError() {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Hostname lookup aborted.', 'AbortError');
    }
    const error = new Error('Hostname lookup aborted.');
    error.name = 'AbortError';
    return error;
}

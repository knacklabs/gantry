type HostnameLookup = (
  hostname: string,
  signal?: AbortSignal | null,
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export async function lookupHostnameWithDeadline(input: {
  hostname: string;
  lookupHostname: HostnameLookup;
  timeoutMs: number;
  timeoutMessage: string;
  signal?: AbortSignal | null;
}): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (input.signal?.aborted) {
    throw abortError();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(input.timeoutMessage));
    }, input.timeoutMs);
    timeout.unref?.();
    onAbort = () => reject(abortError());
    input.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([input.lookupHostname(input.hostname), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) input.signal?.removeEventListener('abort', onAbort);
  }
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Hostname lookup aborted.', 'AbortError');
  }
  const error = new Error('Hostname lookup aborted.');
  error.name = 'AbortError';
  return error;
}

import { nowMs as currentTimeMs } from '../shared/time/datetime.js';

const IPC_RATE_LIMIT_WINDOW_MS = 60_000;
const IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW = 300;

const ipcRateLimitState = new Map<
  string,
  { windowStart: number; count: number }
>();

export function canProcessIpcFile(
  sourceAgentFolder: string,
  kind: string,
): boolean {
  const now = currentTimeMs();
  const key = `${sourceAgentFolder}:${kind}`;
  const state = ipcRateLimitState.get(key);
  if (!state || now - state.windowStart >= IPC_RATE_LIMIT_WINDOW_MS) {
    ipcRateLimitState.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (state.count >= IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW) return false;
  state.count += 1;
  return true;
}

// Peek without counting: true when the next request would be refused.
export function isIpcRateLimited(
  sourceAgentFolder: string,
  kind: string,
): boolean {
  const state = ipcRateLimitState.get(`${sourceAgentFolder}:${kind}`);
  return (
    !!state &&
    currentTimeMs() - state.windowStart < IPC_RATE_LIMIT_WINDOW_MS &&
    state.count >= IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW
  );
}

export function clearIpcRateLimitState(): void {
  ipcRateLimitState.clear();
}

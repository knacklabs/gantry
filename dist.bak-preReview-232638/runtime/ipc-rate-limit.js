import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
const IPC_RATE_LIMIT_WINDOW_MS = 60_000;
const IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW = 300;
const ipcRateLimitState = new Map();
export function canProcessIpcFile(sourceAgentFolder, kind) {
    const now = currentTimeMs();
    const key = `${sourceAgentFolder}:${kind}`;
    const state = ipcRateLimitState.get(key);
    if (!state || now - state.windowStart >= IPC_RATE_LIMIT_WINDOW_MS) {
        ipcRateLimitState.set(key, { windowStart: now, count: 1 });
        return true;
    }
    if (state.count >= IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW)
        return false;
    state.count += 1;
    return true;
}
export function clearIpcRateLimitState() {
    ipcRateLimitState.clear();
}

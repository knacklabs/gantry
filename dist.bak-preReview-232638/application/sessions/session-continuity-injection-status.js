import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
const MAX = 128;
const TTL_MS = 30 * 60 * 1000;
const bySubject = new Map();
export function recordSessionContinuityInjectionStatus(status) {
    prune(currentTimeMs());
    bySubject.delete(keyFor(status.subject));
    while (bySubject.size >= MAX) {
        const oldest = bySubject.keys().next().value;
        if (!oldest)
            break;
        bySubject.delete(oldest);
    }
    bySubject.set(keyFor(status.subject), status);
}
export function getLastSessionContinuityInjectionStatus(subject) {
    if (!subject)
        return undefined;
    const key = keyFor(subject);
    const status = bySubject.get(key);
    if (!status)
        return undefined;
    if (expired(status, currentTimeMs())) {
        bySubject.delete(key);
        return undefined;
    }
    bySubject.delete(key);
    bySubject.set(key, status);
    return status;
}
export function clearSessionContinuityInjectionStatusForTests() {
    bySubject.clear();
}
function keyFor(subject) {
    const parts = subject.userId
        ? [subject.appId, subject.agentId, subject.userId]
        : [subject.appId, subject.agentId, subject.conversationId];
    return parts.map((value) => value || '').join('\u0000');
}
function prune(nowMs) {
    for (const [key, status] of bySubject)
        if (expired(status, nowMs))
            bySubject.delete(key);
}
function expired(status, nowMs) {
    const at = Date.parse(status.injectedAt);
    return !Number.isFinite(at) || nowMs - at > TTL_MS;
}

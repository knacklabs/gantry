import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';

export type ContinuitySectionName =
  | 'recent_session_digests'
  | 'top_scoped_memories'
  | 'recent_decisions'
  | 'active_paused_jobs';
export type ContinuitySectionStatus =
  'populated' | 'empty' | 'unavailable' | 'deferred';
export interface SessionContinuityInjectionSubject {
  appId: string;
  agentId: string;
  conversationId?: string;
  userId?: string;
  threadId?: string;
}
export interface SessionContinuityInjectionStatus {
  injectedAt: string;
  hydrationMode?: 'first_visible' | 'full';
  subject: SessionContinuityInjectionSubject;
  bytes: number;
  maxBytes: number;
  truncated: boolean;
  blockEmpty: boolean;
  sections: Record<
    ContinuitySectionName,
    {
      status: ContinuitySectionStatus;
      count: number;
      items?: unknown[];
    }
  >;
}
const MAX = 128;
const TTL_MS = 30 * 60 * 1000;
const bySubject = new Map<string, SessionContinuityInjectionStatus>();
export function recordSessionContinuityInjectionStatus(
  status: SessionContinuityInjectionStatus,
): void {
  prune(currentTimeMs());
  bySubject.delete(keyFor(status.subject));
  while (bySubject.size >= MAX) {
    const oldest = bySubject.keys().next().value;
    if (!oldest) break;
    bySubject.delete(oldest);
  }
  bySubject.set(keyFor(status.subject), status);
}
export function getLastSessionContinuityInjectionStatus(
  subject: Partial<SessionContinuityInjectionSubject>,
): SessionContinuityInjectionStatus | undefined {
  if (!subject) return undefined;
  const key = keyFor(subject);
  const status = bySubject.get(key);
  if (!status) return undefined;
  if (expired(status, currentTimeMs())) {
    bySubject.delete(key);
    return undefined;
  }
  bySubject.delete(key);
  bySubject.set(key, status);
  return status;
}
export function clearSessionContinuityInjectionStatusForTests(): void {
  bySubject.clear();
}
function keyFor(subject: Partial<SessionContinuityInjectionSubject>): string {
  const parts = subject.userId
    ? [subject.appId, subject.agentId, subject.userId]
    : [subject.appId, subject.agentId, subject.conversationId];
  return parts.map((value) => value || '').join('\u0000');
}
function prune(nowMs: number): void {
  for (const [key, status] of bySubject)
    if (expired(status, nowMs)) bySubject.delete(key);
}
function expired(
  status: SessionContinuityInjectionStatus,
  nowMs: number,
): boolean {
  const at = Date.parse(status.injectedAt);
  return !Number.isFinite(at) || nowMs - at > TTL_MS;
}

import type { Job } from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';

export function jobBelongsToApp(job: Job, appId: string): boolean {
  const linkedSessions = Array.isArray(job.linked_sessions)
    ? job.linked_sessions
    : [];
  const appSessions = linkedSessions.filter((conversationJid) =>
    conversationJid.startsWith('app:'),
  );
  if (appSessions.length === 0) return false;
  return appSessions.every((conversationJid) =>
    appChatJidBelongsToApp(conversationJid, appId),
  );
}

export function resolveJobRuntimeAppId(job: Job, fallback = 'default'): string {
  const appJid = (
    Array.isArray(job.linked_sessions) ? job.linked_sessions : []
  ).find((conversationJid) => conversationJid.startsWith('app:'));
  if (!appJid) return fallback;
  const rest = appJid.slice('app:'.length);
  const delimiterIndex = rest.indexOf(':');
  if (delimiterIndex <= 0 || rest.indexOf(':', delimiterIndex + 1) !== -1) {
    return fallback;
  }
  return rest.slice(0, delimiterIndex) || fallback;
}

export function assertJobBelongsToApp(job: Job, appId: string): void {
  if (!jobBelongsToApp(job, appId)) {
    throw new ApplicationError('FORBIDDEN', 'API key cannot access this job');
  }
}

function appChatJidBelongsToApp(
  conversationJid: string,
  appId: string,
): boolean {
  const rest = conversationJid.slice('app:'.length);
  const delimiterIndex = rest.indexOf(':');
  if (delimiterIndex <= 0 || rest.indexOf(':', delimiterIndex + 1) !== -1) {
    return false;
  }
  return rest.slice(0, delimiterIndex) === appId;
}

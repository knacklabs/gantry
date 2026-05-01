import type { RuntimeResponseMode } from '../domain/events/events.js';
import type { Job } from '../domain/types.js';
import { parseTriggerRequesterSessionId } from './execution-context.js';

interface EventAppSession {
  appId: string;
  sessionId: string;
  defaultResponseMode: RuntimeResponseMode | null;
  defaultWebhookId: string | null;
}

interface RuntimeControlSessionReader {
  getAppSessionById(
    sessionId: string,
  ): Promise<EventAppSession | null | undefined>;
  getAppSessionByChatJid(
    chatJid: string,
  ): Promise<EventAppSession | null | undefined>;
}

export type SchedulerEventAppSession = EventAppSession | undefined;

export async function resolveAppSessionForJob(
  job: Pick<Job, 'session_id' | 'linked_sessions'>,
  control: RuntimeControlSessionReader,
): Promise<SchedulerEventAppSession> {
  if (job.session_id) {
    const session = await control.getAppSessionById(job.session_id);
    if (session) return session;
  }
  const appJid = job.linked_sessions.find((jid) => jid.startsWith('app:'));
  return appJid
    ? (await control.getAppSessionByChatJid(appJid)) || undefined
    : undefined;
}

export async function resolveAppSessionForTrigger(
  requestedBy: string,
  control: RuntimeControlSessionReader,
): Promise<SchedulerEventAppSession> {
  const sessionId = parseTriggerRequesterSessionId(requestedBy);
  return sessionId
    ? (await control.getAppSessionById(sessionId)) || undefined
    : undefined;
}

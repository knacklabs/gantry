import type { Job } from '../../domain/types.js';
import type {
  AppSessionRecord,
  JobControlPort,
} from './job-management-types.js';

export const DEFAULT_JOB_RUNTIME_APP_ID = 'default';

export function isDefaultRuntimeJobScope(appId: string): boolean {
  return appId === DEFAULT_JOB_RUNTIME_APP_ID;
}

export interface JobAppSessionLookupRecord {
  sessionId: string;
  appId: string;
  conversationJid?: string;
  chatJid?: string;
}

export interface JobAppSessionLookupPort {
  getAppSessionsByIds(
    sessionIds: readonly string[],
  ): Promise<JobAppSessionLookupRecord[]>;
  getAppSessionsByChatJids?(
    conversationJids: readonly string[],
  ): Promise<JobAppSessionLookupRecord[]>;
  getAppSessionByChatJid(
    conversationJid: string,
  ): Promise<JobAppSessionLookupRecord | undefined>;
}

export async function resolveJobAppSession(input: {
  control: JobControlPort;
  job: Job;
  appId: string;
}): Promise<AppSessionRecord | undefined> {
  const { appId, control, job } = input;
  if (job.session_id) {
    const session = await control.getAppSessionById(job.session_id);
    if (session?.appId === appId) return session;
    return undefined;
  }
  const conversationJid = job.execution_context?.conversationJid?.trim();
  if (conversationJid) {
    const session = await control.getAppSessionByChatJid(conversationJid);
    if (session?.appId === appId) return session;
    if (session) return undefined;
  }
  if (isDefaultRuntimeJobScope(appId)) {
    return {
      sessionId: '',
      appId,
      conversationJid: conversationJid ?? '',
      workspaceKey: job.workspace_key,
      defaultResponseMode: 'none',
      defaultWebhookId: null,
    };
  }
  return undefined;
}

export async function filterJobsByCanonicalAppSession(input: {
  control: JobAppSessionLookupPort;
  jobs: readonly Job[];
  appId: string;
}): Promise<Job[]> {
  const includeHostOwnedJobs = isDefaultRuntimeJobScope(input.appId);
  const sessionIds = Array.from(
    new Set(
      input.jobs
        .map((job) => job.session_id?.trim())
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ),
  );
  if (sessionIds.length === 0) {
    return includeHostOwnedJobs
      ? input.jobs.filter((job) => !job.session_id)
      : [];
  }
  const sessions = await input.control.getAppSessionsByIds(sessionIds);
  const allowedSessionIds = new Set(
    sessions
      .filter((session) => session.appId === input.appId)
      .map((session) => session.sessionId),
  );
  const sessionlessJobs = input.jobs.filter((job) => !job.session_id);
  const sessionlessConversationJids = Array.from(
    new Set(
      sessionlessJobs
        .map((job) => job.execution_context?.conversationJid?.trim())
        .filter((jid): jid is string => Boolean(jid)),
    ),
  );
  const conversationSessions =
    sessionlessConversationJids.length > 0
      ? input.control.getAppSessionsByChatJids
        ? await input.control.getAppSessionsByChatJids(
            sessionlessConversationJids,
          )
        : (
            await Promise.all(
              sessionlessConversationJids.map((jid) =>
                input.control.getAppSessionByChatJid(jid),
              ),
            )
          ).filter(
            (session): session is AppSessionRecord => session !== undefined,
          )
      : [];
  const allowedConversationJids = new Set(
    conversationSessions
      .filter((session) => session.appId === input.appId)
      .map(sessionConversationJid)
      .filter((jid): jid is string => Boolean(jid)),
  );
  const knownConversationJids = new Set(
    conversationSessions
      .map(sessionConversationJid)
      .filter((jid): jid is string => Boolean(jid)),
  );
  return input.jobs.filter((job) =>
    job.session_id
      ? allowedSessionIds.has(job.session_id)
      : job.execution_context?.conversationJid
        ? allowedConversationJids.has(job.execution_context.conversationJid) ||
          (includeHostOwnedJobs &&
            !knownConversationJids.has(job.execution_context.conversationJid))
        : includeHostOwnedJobs,
  );
}

function sessionConversationJid(
  session: JobAppSessionLookupRecord,
): string | undefined {
  return session.conversationJid ?? session.chatJid;
}

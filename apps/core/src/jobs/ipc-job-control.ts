import type {
  AppSessionRecord,
  JobControlPort,
  JobTriggerRecord,
} from '../application/jobs/job-management-types.js';

interface RuntimeAppSessionRecord {
  sessionId: string;
  appId: string;
  chatJid: string;
  workspaceKey: string;
  defaultResponseMode: AppSessionRecord['defaultResponseMode'];
  defaultWebhookId: string | null;
}

interface RuntimeControlRepositoryPort {
  getAppSessionById(
    sessionId: string,
  ): Promise<RuntimeAppSessionRecord | undefined>;
  getAppSessionsByIds(
    sessionIds: readonly string[],
  ): Promise<RuntimeAppSessionRecord[]>;
  getAppSessionByChatJid(
    conversationJid: string,
  ): Promise<RuntimeAppSessionRecord | undefined>;
  getAppSessionsByChatJids(
    conversationJids: readonly string[],
  ): Promise<RuntimeAppSessionRecord[]>;
  createJobTrigger(input: {
    jobId: string;
    requestedBy?: string;
  }): Promise<JobTriggerRecord>;
  markTriggerCompleted(
    triggerId: string,
    status: 'completed' | 'failed',
  ): Promise<void>;
  getTriggerById(triggerId: string): Promise<JobTriggerRecord | undefined>;
}

function adaptAppSession(
  session: RuntimeAppSessionRecord | undefined,
): AppSessionRecord | undefined {
  if (!session) return undefined;
  return {
    sessionId: session.sessionId,
    appId: session.appId,
    conversationJid: session.chatJid,
    workspaceKey: session.workspaceKey,
    defaultResponseMode: session.defaultResponseMode,
    defaultWebhookId: session.defaultWebhookId,
  };
}

export function adaptJobControl(
  control: RuntimeControlRepositoryPort,
): JobControlPort {
  return {
    async getAppSessionById(sessionId) {
      return adaptAppSession(await control.getAppSessionById(sessionId));
    },
    async getAppSessionsByIds(sessionIds) {
      const sessions = await control.getAppSessionsByIds(sessionIds);
      return sessions
        .map((session) => adaptAppSession(session))
        .filter((session): session is AppSessionRecord => Boolean(session));
    },
    async getAppSessionByChatJid(conversationJid) {
      return adaptAppSession(
        await control.getAppSessionByChatJid(conversationJid),
      );
    },
    async getAppSessionsByChatJids(conversationJids) {
      const sessions = await control.getAppSessionsByChatJids(conversationJids);
      return sessions
        .map((session) => adaptAppSession(session))
        .filter((session): session is AppSessionRecord => Boolean(session));
    },
    createJobTrigger: (input) => control.createJobTrigger(input),
    markTriggerCompleted: (triggerId, status) =>
      control.markTriggerCompleted(triggerId, status),
    getTriggerById: (triggerId) => control.getTriggerById(triggerId),
  };
}

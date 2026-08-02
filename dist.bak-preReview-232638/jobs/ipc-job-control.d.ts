import type { AppSessionRecord, JobControlPort, JobTriggerRecord } from '../application/jobs/job-management-types.js';
interface RuntimeAppSessionRecord {
    sessionId: string;
    appId: string;
    chatJid: string;
    workspaceKey: string;
    defaultResponseMode: AppSessionRecord['defaultResponseMode'];
    defaultWebhookId: string | null;
}
interface RuntimeControlRepositoryPort {
    getAppSessionById(sessionId: string): Promise<RuntimeAppSessionRecord | undefined>;
    getAppSessionsByIds(sessionIds: readonly string[]): Promise<RuntimeAppSessionRecord[]>;
    getAppSessionByChatJid(conversationJid: string): Promise<RuntimeAppSessionRecord | undefined>;
    getAppSessionsByChatJids(conversationJids: readonly string[]): Promise<RuntimeAppSessionRecord[]>;
    createJobTrigger(input: {
        jobId: string;
        requestedBy?: string;
    }): Promise<JobTriggerRecord>;
    markTriggerCompleted(triggerId: string, status: 'completed' | 'failed'): Promise<void>;
    getTriggerById(triggerId: string): Promise<JobTriggerRecord | undefined>;
}
export declare function adaptJobControl(control: RuntimeControlRepositoryPort): JobControlPort;
export {};

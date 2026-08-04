import type { Job } from '../../domain/types.js';
import type { AppSessionRecord, JobControlPort } from './job-management-types.js';
export declare const DEFAULT_JOB_RUNTIME_APP_ID = "default";
export declare function isDefaultRuntimeJobScope(appId: string): boolean;
export interface JobAppSessionLookupRecord {
    sessionId: string;
    appId: string;
    conversationJid?: string;
    chatJid?: string;
}
export interface JobAppSessionLookupPort {
    getAppSessionsByIds(sessionIds: readonly string[]): Promise<JobAppSessionLookupRecord[]>;
    getAppSessionsByChatJids?(conversationJids: readonly string[]): Promise<JobAppSessionLookupRecord[]>;
    getAppSessionByChatJid(conversationJid: string): Promise<JobAppSessionLookupRecord | undefined>;
}
export declare function resolveJobAppSession(input: {
    control: JobControlPort;
    job: Job;
    appId: string;
}): Promise<AppSessionRecord | undefined>;
export declare function filterJobsByCanonicalAppSession(input: {
    control: JobAppSessionLookupPort;
    jobs: readonly Job[];
    appId: string;
}): Promise<Job[]>;

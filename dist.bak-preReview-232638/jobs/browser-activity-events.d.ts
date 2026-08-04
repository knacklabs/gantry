import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { Job } from '../domain/types.js';
import { type SchedulerEventAppSession } from './app-session-resolution.js';
interface RuntimeControlSessionReader {
    getAppSessionById(sessionId: string): Promise<SchedulerEventAppSession | null | undefined>;
}
export interface BrowserJobActivityInput {
    jobId: string;
    runId: string;
    tool: string;
    publicToolName?: string | null;
    action?: string | null;
    ok: boolean;
    elapsedMs: number;
    normalizedSite?: string | null;
    policyMode?: string | null;
    warning?: string | null;
    error?: string | null;
}
export declare function publishBrowserJobActivityEvent(input: {
    activity: BrowserJobActivityInput;
    getJobById: (jobId: string) => Promise<Pick<Job, 'session_id'> | undefined>;
    controlRepository: RuntimeControlSessionReader;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<void> | void;
    runtimeAppId?: string;
    logger?: {
        warn(payload: Record<string, unknown>, message: string): void;
    };
}): Promise<void>;
export {};

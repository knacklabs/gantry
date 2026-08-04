import type { RuntimeResponseMode } from '../domain/events/events.js';
import type { Job } from '../domain/types.js';
interface EventAppSession {
    appId: string;
    sessionId: string;
    defaultResponseMode: RuntimeResponseMode | null;
    defaultWebhookId: string | null;
}
interface RuntimeControlSessionReader {
    getAppSessionById(sessionId: string): Promise<EventAppSession | null | undefined>;
}
export type SchedulerEventAppSession = EventAppSession | undefined;
export declare function resolveAppSessionForJob(job: Pick<Job, 'session_id'>, control: RuntimeControlSessionReader): Promise<SchedulerEventAppSession>;
export declare function resolveAppSessionForTrigger(requestedBy: string, control: RuntimeControlSessionReader): Promise<SchedulerEventAppSession>;
export {};

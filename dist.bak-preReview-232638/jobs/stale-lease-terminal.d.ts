import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { ReleasedStaleJobLease, RuntimeJobRepository } from '../domain/repositories/ops-repo.js';
import { type SchedulerEventAppSession } from './app-session-resolution.js';
import type { SchedulerSendMessage } from './delivery.js';
interface RuntimeControlSessionReader {
    getAppSessionById(sessionId: string): Promise<SchedulerEventAppSession | null | undefined>;
}
export declare function notifyReleasedStaleJobLeases(input: {
    releases: readonly ReleasedStaleJobLease[];
    opsRepository: Pick<RuntimeJobRepository, 'getJobById' | 'getJobRunById' | 'markJobRunNotified'>;
    sendMessage: SchedulerSendMessage;
    controlRepository: RuntimeControlSessionReader;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<void> | void;
    runtimeAppId?: string;
    logger?: {
        warn(payload: Record<string, unknown>, message: string): void;
    };
}): Promise<void>;
export {};

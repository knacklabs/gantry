import type { AppId } from '../domain/app/app.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { recheckSetupPausedJobsAfterCapabilityUpdate } from '../application/jobs/job-permission-recovery.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
type RequestAccessRecoveryResult = Awaited<ReturnType<typeof recheckSetupPausedJobsAfterCapabilityUpdate>>;
export declare function recheckPausedSetupJobsAfterRequestAccessGrant(input: {
    deps: IpcDeps;
    appId: AppId;
    sourceAgentFolder: string;
    targetJid: string;
    jobId?: string;
    logWarn?: (context: Record<string, unknown>, message: string) => void;
}): Promise<RequestAccessRecoveryResult | undefined>;
export declare function formatRequestAccessPersistentGrantMessage(input: {
    displayName: string;
    rules: string[];
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
    recovery?: RequestAccessRecoveryResult;
}): string;
export {};

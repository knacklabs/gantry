import type { JobControlPort, JobManagementServiceDeps, JobTriggerQueuePort, RuntimeEventPublisherPort } from './job-management-types.js';
export declare function requireJobControl(deps: JobManagementServiceDeps): JobControlPort;
export declare function requireRuntimeEvents(deps: JobManagementServiceDeps): RuntimeEventPublisherPort;
export declare function requireTriggerQueue(deps: JobManagementServiceDeps): JobTriggerQueuePort;

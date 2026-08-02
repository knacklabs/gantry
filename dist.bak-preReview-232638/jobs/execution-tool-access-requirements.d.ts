import { type ToolAccessRequirementPreflightResult } from '../application/jobs/job-tool-access-requirements.js';
import { type RuntimeEventType } from '../domain/events/runtime-event-types.js';
export declare function assertToolAccessRequirementsReadyForRun(input: {
    toolAccessRequirements?: readonly string[];
    effectiveAllowedTools: readonly string[];
    emitJobEvent: (eventType: RuntimeEventType, payload: Record<string, unknown>) => Promise<void>;
}): Promise<ToolAccessRequirementPreflightResult>;

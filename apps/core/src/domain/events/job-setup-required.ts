import type { JobSetupBlocker, JobSetupState } from '../job-types.js';
import { jobSetupActionEventPayload } from './job-setup-action.js';

export function jobSetupRequiredEventPayload(input: {
  jobId: string;
  setupState: JobSetupState;
  notified?: boolean;
}): Record<string, unknown> {
  // Frozen top-level fields survive the action cutover (review R10): only
  // blocker-level legacy action fields changed shape.
  return {
    jobId: input.jobId,
    setup_state: input.setupState.state,
    blocker_fingerprint: input.setupState.fingerprint,
    ...(input.notified !== undefined ? { notified: input.notified } : {}),
    blockers: input.setupState.blockers.map(jobSetupBlockerEventPayload),
  };
}

function jobSetupBlockerEventPayload(blocker: JobSetupBlocker) {
  return {
    id: blocker.id,
    state: blocker.state,
    type: blocker.type,
    summary: blocker.summary,
    action: jobSetupActionEventPayload(blocker.action),
  };
}

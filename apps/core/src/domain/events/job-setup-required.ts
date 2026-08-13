import type { JobSetupBlocker, JobSetupState } from '../job-types.js';
import { jobSetupActionEventPayload } from './job-setup-action.js';

export function jobSetupRequiredEventPayload(input: {
  setupState: JobSetupState;
}): Record<string, unknown> {
  return {
    setup_fingerprint: input.setupState.fingerprint,
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

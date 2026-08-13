import type { JobSetupAction } from '../job-types.js';

export type JobSetupActionEventPayload =
  | Extract<JobSetupAction, { kind: 'approve_grant' | 'instruction' }>
  | { kind: 'fix_proposal'; proposal_id: string };

export function jobSetupActionEventPayload(
  action: JobSetupAction,
): JobSetupActionEventPayload {
  return action.kind === 'fix_proposal'
    ? { kind: 'fix_proposal', proposal_id: action.proposalId }
    : action;
}

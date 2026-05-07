import type { Job } from '../../domain/types.js';
import { agentIdForJobGroupScope } from './job-tool-policy.js';
import { canAccessSchedulerJob } from './job-management-access.js';
import type { JobKind, SchedulerJobAccess } from './job-management-types.js';

export interface JobVisibilityFilter {
  appId?: string;
  access?: SchedulerJobAccess;
  agentId?: string;
  kind?: JobKind;
  conversationJid?: string;
}

export function isVisibleJob(job: Job, input: JobVisibilityFilter): boolean {
  if (input.appId) return false;
  if (input.access && !canAccessSchedulerJob(job, input.access)) return false;
  if (
    input.agentId &&
    agentIdForJobGroupScope(job.group_scope) !== input.agentId
  )
    return false;
  if (input.kind && jobKindFor(job) !== input.kind) return false;
  if (
    input.conversationJid &&
    !job.linked_sessions.includes(input.conversationJid)
  ) {
    return false;
  }
  return true;
}

export function jobKindFor(job: Job): JobKind {
  if (job.schedule_type === 'manual') return 'manual';
  if (job.schedule_type === 'once') return 'once';
  return 'recurring';
}

import type { Job } from '../../domain/types.js';
import { agentIdForJobWorkspaceKey } from './job-tool-policy.js';
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
    agentIdForJobWorkspaceKey(job.workspace_key) !== input.agentId
  )
    return false;
  if (input.kind && jobKindFor(job) !== input.kind) return false;
  if (
    input.conversationJid &&
    !jobTargetsConversation(job, input.conversationJid)
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

function jobTargetsConversation(job: Job, conversationJid: string): boolean {
  const notificationRoutes = Array.isArray(job.notification_routes)
    ? job.notification_routes
    : [];
  if (notificationRoutes.length > 0) {
    return notificationRoutes.some(
      (route) => route.conversationJid === conversationJid,
    );
  }
  return job.execution_context?.conversationJid === conversationJid;
}

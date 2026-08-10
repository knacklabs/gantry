import type { Job } from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';
import type { SchedulerJobAccess } from './job-management-types.js';

export function normalizeOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function canAccessSchedulerJob(
  job: Job,
  access: SchedulerJobAccess,
): boolean {
  const originConversationJid = normalizeOptional(access.originConversationJid);
  if (!originConversationJid) return false;
  const originProviderAccountId = normalizeOptional(
    access.originProviderAccountId,
  );
  if (job.workspace_key !== access.sourceAgentFolder) return false;
  const executionConversationJid = normalizeOptional(
    job.execution_context?.conversationJid,
  );
  const notificationRoutes = Array.isArray(job.notification_routes)
    ? job.notification_routes
    : [];
  if (executionConversationJid) {
    if (executionConversationJid !== originConversationJid) return false;
    if (!originProviderAccountId) return true;
    return notificationRoutes.some(
      (route) =>
        normalizeOptional(route.conversationJid) === originConversationJid &&
        normalizeOptional(route.providerAccountId) === originProviderAccountId,
    );
  }
  if (notificationRoutes.length > 0) {
    return notificationRoutes.some(
      (route) =>
        normalizeOptional(route.conversationJid) === originConversationJid &&
        (!originProviderAccountId ||
          normalizeOptional(route.providerAccountId) ===
            originProviderAccountId),
    );
  }
  return true;
}

export function assertSchedulerJobAccess(
  _job: Job,
  access: SchedulerJobAccess,
): void {
  if (!canAccessSchedulerJob(_job, access)) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Job does not belong to this source group or conversation.',
    );
  }
}

export function validateSchedulerUpdate(
  _job: Job,
  updates: Partial<Job>,
  access: SchedulerJobAccess,
): void {
  if (
    updates.workspace_key &&
    updates.workspace_key !== access.sourceAgentFolder
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Scheduler jobs cannot move outside the source group.',
    );
  }
  if (updates.execution_context) {
    const contextConversationJid = normalizeOptional(
      updates.execution_context.conversationJid,
    );
    if (
      contextConversationJid !== normalizeOptional(access.originConversationJid)
    ) {
      throw new ApplicationError(
        'FORBIDDEN',
        'executionContext conversation must match authenticated conversation.',
      );
    }
  }
}

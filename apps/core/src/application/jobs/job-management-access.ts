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
  if (job.workspace_key !== access.sourceAgentFolder) return false;
  const executionConversationJid = normalizeOptional(
    job.execution_context?.conversationJid,
  );
  if (executionConversationJid) {
    return executionConversationJid === originConversationJid;
  }
  const notificationRoutes = Array.isArray(job.notification_routes)
    ? job.notification_routes
    : [];
  if (notificationRoutes.length > 0) {
    return notificationRoutes.some(
      (route) =>
        normalizeOptional(route.conversationJid) === originConversationJid,
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
  if (updates.thread_id !== undefined) {
    const requestedThreadId = updates.thread_id || null;
    const authThreadId = normalizeOptional(access.authThreadId) ?? null;
    if (requestedThreadId && requestedThreadId !== authThreadId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'threadId payload does not match authenticated thread binding.',
      );
    }
  }
  if (updates.execution_context) {
    const contextConversationJid = normalizeOptional(
      updates.execution_context.conversationJid,
    );
    const contextThreadId =
      normalizeOptional(updates.execution_context.threadId) ?? null;
    const authThreadId = normalizeOptional(access.authThreadId) ?? null;
    if (
      contextConversationJid !== normalizeOptional(access.originConversationJid)
    ) {
      throw new ApplicationError(
        'FORBIDDEN',
        'executionContext conversation must match authenticated conversation.',
      );
    }
    if (contextThreadId !== authThreadId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'executionContext threadId must match authenticated thread binding.',
      );
    }
  }
}

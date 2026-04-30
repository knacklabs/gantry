import type { Job } from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';
import type { SchedulerJobAccess } from './job-management-types.js';

export function normalizeOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveLinkedSessions(
  input: { linkedSessions?: string[]; deliverTo?: string[] },
  access: SchedulerJobAccess,
): string[] {
  let linkedSessions = Array.isArray(input.deliverTo)
    ? input.deliverTo.map(String).filter((item) => item.length > 0)
    : Array.isArray(input.linkedSessions)
      ? input.linkedSessions.map(String).filter((item) => item.length > 0)
      : (access.sourceGroupJids ?? []);
  if (linkedSessions.length === 0)
    linkedSessions = access.sourceGroupJids ?? [];
  if (linkedSessions.length === 0) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'scheduler_upsert_job requires at least one linked session.',
    );
  }
  if (!access.isMain) {
    const unauthorized = linkedSessions.some((jid) => {
      const binding = access.conversationBindings[jid];
      return !binding || binding.folder !== access.sourceGroup;
    });
    if (unauthorized) {
      throw new ApplicationError(
        'FORBIDDEN',
        'linked_sessions must belong to the source group for non-main agents.',
      );
    }
  }
  return linkedSessions;
}

export function canAccessSchedulerJob(
  job: Job,
  access: SchedulerJobAccess,
): boolean {
  if (access.authThreadId) {
    if ((job.thread_id || null) !== access.authThreadId) return false;
  } else if ((job.thread_id || null) !== null) {
    return false;
  }
  if (access.isMain) return true;
  if (job.group_scope !== access.sourceGroup) return false;
  return job.linked_sessions.every((jid) => {
    const binding = access.conversationBindings[jid];
    return !!binding && binding.folder === access.sourceGroup;
  });
}

export function assertSchedulerJobAccess(
  job: Job,
  access: SchedulerJobAccess,
): void {
  if (!canAccessSchedulerJob(job, access)) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Job does not belong to this source group or thread.',
    );
  }
}

export function validateSchedulerUpdate(
  job: Job,
  updates: Partial<Job>,
  access: SchedulerJobAccess,
): void {
  if (
    !access.isMain &&
    updates.group_scope &&
    updates.group_scope !== access.sourceGroup
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Only the main agent can set groupScope outside the source group.',
    );
  }
  if (updates.thread_id !== undefined) {
    const requestedThreadId = updates.thread_id || null;
    const authThreadId = normalizeOptional(access.authThreadId) ?? null;
    const currentThreadId = job.thread_id || null;
    const allowed = authThreadId
      ? requestedThreadId === authThreadId
      : requestedThreadId === null && currentThreadId === null;
    if (!allowed) {
      throw new ApplicationError(
        'FORBIDDEN',
        'threadId payload does not match authenticated thread binding.',
      );
    }
  }
  if (!access.isMain && updates.linked_sessions) {
    const unauthorized = updates.linked_sessions.some((jid) => {
      const binding = access.conversationBindings[jid];
      return !binding || binding.folder !== access.sourceGroup;
    });
    if (unauthorized) {
      throw new ApplicationError(
        'FORBIDDEN',
        'linked_sessions must belong to the source group for non-main agents.',
      );
    }
  }
}

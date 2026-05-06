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
  const originConversationJid = normalizeOptional(access.originConversationJid);
  if (!originConversationJid) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Scheduler job access requires an originating conversation.',
    );
  }
  const linkedSessions = Array.isArray(input.deliverTo)
    ? input.deliverTo.map((item) => String(item).trim()).filter(Boolean)
    : Array.isArray(input.linkedSessions)
      ? input.linkedSessions.map((item) => String(item).trim()).filter(Boolean)
      : [originConversationJid];
  if (linkedSessions.length === 0) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'scheduler_upsert_job requires at least one linked session.',
    );
  }
  if (!linkedSessions.includes(originConversationJid)) {
    throw new ApplicationError(
      'FORBIDDEN',
      'linked_sessions must include the originating conversation.',
    );
  }
  const unauthorized = linkedSessions.some((jid) => {
    const binding = access.conversationBindings[jid];
    return !binding || binding.folder !== access.sourceAgentFolder;
  });
  if (unauthorized) {
    throw new ApplicationError(
      'FORBIDDEN',
      'linked_sessions must belong to the source group.',
    );
  }
  return linkedSessions;
}

export function canAccessSchedulerJob(
  job: Job,
  access: SchedulerJobAccess,
): boolean {
  const originConversationJid = normalizeOptional(access.originConversationJid);
  if (!originConversationJid) return false;
  if (job.group_scope !== access.sourceAgentFolder) return false;
  if (!job.linked_sessions.includes(originConversationJid)) return false;
  return job.linked_sessions.every((jid) => {
    const binding = access.conversationBindings[jid];
    return !!binding && binding.folder === access.sourceAgentFolder;
  });
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
  if (updates.group_scope && updates.group_scope !== access.sourceAgentFolder) {
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
  if (updates.linked_sessions) {
    resolveLinkedSessions({ linkedSessions: updates.linked_sessions }, access);
  }
}

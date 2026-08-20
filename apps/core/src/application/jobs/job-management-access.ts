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
    return notificationRoutes.some((route) =>
      routeReachableFromAccount(
        route,
        originConversationJid,
        originProviderAccountId,
      ),
    );
  }
  if (notificationRoutes.length > 0) {
    return notificationRoutes.some(
      (route) =>
        normalizeOptional(route.conversationJid) === originConversationJid &&
        (!originProviderAccountId ||
          routeReachableFromAccount(
            route,
            originConversationJid,
            originProviderAccountId,
          )),
    );
  }
  return true;
}

// A notification route in the right conversation is reachable from a querying
// provider account when it is BOUND to that account — or bound to NO account at
// all. An unbound route (no providerAccountId, e.g. a job created before routes
// carried the account) is not claiming any installation, so it cannot leak
// across accounts; hiding it just makes the owner's own job invisible. A route
// bound to a DIFFERENT account still fails, so the fail-closed guarantee holds
// for genuinely account-scoped routes.
function routeReachableFromAccount(
  route: NonNullable<Job['notification_routes']>[number],
  originConversationJid: string,
  originProviderAccountId: string,
): boolean {
  if (normalizeOptional(route.conversationJid) !== originConversationJid) {
    return false;
  }
  const routeProviderAccountId = normalizeOptional(route.providerAccountId);
  return (
    routeProviderAccountId === undefined ||
    routeProviderAccountId === originProviderAccountId
  );
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

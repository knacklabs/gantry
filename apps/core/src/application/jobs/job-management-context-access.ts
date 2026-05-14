import { ApplicationError } from '../common/application-error.js';
import {
  isDefaultRuntimeJobScope,
  resolveJobAppSession,
} from './job-access.js';
import {
  assertExecutionContextMatchesAuthenticatedContext,
  authenticatedContextFromAccess,
  normalizeExecutionContext,
} from './job-management-helpers.js';
import { normalizeOptional } from './job-management-access.js';
import type {
  Job,
  JobManagementServiceDeps,
  JobUpdatePatch,
  SchedulerJobAccess,
} from './job-management-types.js';

export async function resolveAuthenticatedRouteContextForUpdate(input: {
  deps: JobManagementServiceDeps;
  job: Job;
  appId?: string;
  access?: SchedulerJobAccess;
  groupScope: string;
  patchExecutionContext?: JobUpdatePatch['executionContext'];
}): Promise<{
  conversationJid: string;
  threadId: string | null;
  groupScope: string;
} | null> {
  if (input.access) {
    return assertExecutionContextMatchesAuthenticatedContext({
      executionContext: input.patchExecutionContext,
      authenticatedContext: authenticatedContextFromAccess(
        input.access,
        input.groupScope,
      ),
    });
  }
  if (!input.deps.control) return null;
  const requestedExecutionContext =
    input.patchExecutionContext !== undefined
      ? normalizeExecutionContext(input.patchExecutionContext)
      : undefined;
  const sessionId =
    normalizeOptional(requestedExecutionContext?.sessionId) ??
    normalizeOptional(input.job.session_id);
  if (!sessionId) {
    if (requestedExecutionContext) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Cannot update executionContext without an authenticated app session.',
      );
    }
    return null;
  }
  const session = await input.deps.control.getAppSessionById(sessionId);
  if (!session) {
    throw new ApplicationError('FORBIDDEN', 'API key cannot access this job');
  }
  if (input.appId && session.appId !== input.appId) {
    throw new ApplicationError('FORBIDDEN', 'API key cannot access this job');
  }
  return {
    conversationJid: session.conversationJid,
    groupScope: session.workspaceKey,
    threadId:
      requestedExecutionContext?.threadId ??
      normalizeOptional(input.job.thread_id) ??
      null,
  };
}

export async function assertJobAppAccess(input: {
  deps: JobManagementServiceDeps;
  job: Job;
  appId: string;
}): Promise<void> {
  if (!input.job.session_id && isDefaultRuntimeJobScope(input.appId)) return;
  if (!input.deps.control) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Job control repository unavailable',
    );
  }
  const appSession = await resolveJobAppSession({
    control: input.deps.control,
    job: input.job,
    appId: input.appId,
  });
  if (appSession?.appId === input.appId) return;
  throw new ApplicationError('FORBIDDEN', 'API key cannot access this job');
}

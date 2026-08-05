import { permissionRunRestriction } from '../runtime/permission-decision-coordinator.js';
import type { TaskContext } from './ipc-types.js';

type RejectSchedulerMutation = (error: string, code?: string) => void;

export function rejectDisallowedSchedulerMutation(
  context: TaskContext,
  reject: RejectSchedulerMutation,
): boolean {
  const responseKeyId = context.data.responseKeyId;
  const restriction = responseKeyId
    ? permissionRunRestriction({
        sourceAgentFolder: context.sourceAgentFolder,
        responseKeyId,
      })
    : undefined;

  if (restriction?.runKind === 'scheduled') {
    reject(
      'Scheduled runs cannot mutate scheduler jobs. Report a proposedJobChange instead.',
      'permission_denied',
    );
    return true;
  }

  if (
    !restriction ||
    context.data.sourceRunKind !== restriction.runKind ||
    context.data.sourceJobId !== restriction.jobId ||
    context.data.sourceRunId !== restriction.runId
  ) {
    reject(
      'Scheduler mutation source could not be verified.',
      'permission_denied',
    );
    return true;
  }

  return false;
}

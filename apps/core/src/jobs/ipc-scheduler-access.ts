import { ApplicationError } from '../application/common/application-error.js';
import type { SchedulerJobAccess } from '../application/jobs/job-management-types.js';
import { toTrimmedString } from './ipc-shared.js';
import type { TaskContext } from './ipc-types.js';

export function schedulerAccessFromContext(
  context: TaskContext,
): SchedulerJobAccess {
  const originConversationJid = toTrimmedString(context.data.chatJid, {
    maxLen: 255,
  });
  if (!originConversationJid) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Scheduler job operations require an originating conversation.',
    );
  }
  if (!context.conversationBindings) {
    throw new Error('Scheduler IPC context missing conversation bindings.');
  }
  if (!context.sourceGroupJids.includes(originConversationJid)) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Scheduler job operations must originate from a conversation bound to this agent.',
    );
  }
  return {
    sourceGroup: context.sourceGroup,
    originConversationJid,
    isMain: context.isMain,
    conversationBindings: context.conversationBindings,
    sourceGroupJids: context.sourceGroupJids,
    authThreadId: context.data.authThreadId,
  };
}

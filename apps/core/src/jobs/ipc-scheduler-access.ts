import { ApplicationError } from '../application/common/application-error.js';
import type { SchedulerJobAccess } from '../application/jobs/job-management-types.js';
import { toTrimmedString } from './ipc-shared.js';
import type { TaskContext } from './ipc-types.js';
import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';

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
  if (
    !context.sourceAgentFolderJids.includes(originConversationJid) &&
    !hasBoundOriginConversation(context)
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Scheduler job operations must originate from a conversation bound to this agent.',
    );
  }
  const originProviderAccountId = toTrimmedString(
    context.data.providerAccountId,
    {
      maxLen: 255,
    },
  );
  if (originProviderAccountId && !hasBoundProviderAccount(context)) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Scheduler job operations must originate from the authenticated provider account.',
    );
  }
  // Acting person = the creating turn's resolved memory identity, the same
  // source personal memory already trusts. It is null for every non-DM or
  // ineligible turn (the locked ID-1 DM boundary in resolveCanonicalMemoryPersonId),
  // so a group-created job is shared and only an eligible DM turn carries a person.
  const actingPersonId =
    toTrimmedString(context.data.memoryUserId, { maxLen: 255 }) ?? null;
  return {
    sourceAgentFolder: context.sourceAgentFolder,
    originConversationJid,
    originProviderAccountId,
    actingPersonId,
    conversationBindings: context.conversationBindings,
    sourceConversationJids: context.sourceAgentFolderJids,
    authThreadId: context.data.authThreadId,
  };
}

function hasBoundOriginConversation(context: TaskContext): boolean {
  return Object.entries(context.conversationBindings).some(([key, route]) => {
    const parsed = parseAgentThreadQueueKey(key);
    return (
      parsed.chatJid === context.data.chatJid &&
      route.folder === context.sourceAgentFolder
    );
  });
}

function hasBoundProviderAccount(context: TaskContext): boolean {
  const requested = toTrimmedString(context.data.providerAccountId, {
    maxLen: 255,
  });
  if (!requested) return true;
  return Object.entries(context.conversationBindings).some(([key, route]) => {
    const parsed = parseAgentThreadQueueKey(key);
    return (
      parsed.chatJid === context.data.chatJid &&
      route.folder === context.sourceAgentFolder &&
      (parsed.providerAccountId ?? route.providerAccountId) === requested
    );
  });
}

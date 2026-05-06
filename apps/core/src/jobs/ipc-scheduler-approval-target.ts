import type { TaskContext } from './ipc-types.js';
import { toTrimmedString } from './ipc-shared.js';

export function resolveSchedulerApprovalTarget(
  context: TaskContext,
): { ok: true; targetJid: string } | { ok: false; reason: string } {
  const requestedTargetJid = toTrimmedString(context.data.chatJid, {
    maxLen: 512,
  });
  const targetOverride = toTrimmedString(
    context.data.targetJid || context.data.jid,
    { maxLen: 512 },
  );

  if (targetOverride && targetOverride !== requestedTargetJid) {
    return {
      ok: false,
      reason:
        'scheduler job tool approval must use the originating chat as the approval target',
    };
  }

  if (
    !requestedTargetJid ||
    !context.sourceAgentFolderJids.includes(requestedTargetJid)
  ) {
    return {
      ok: false,
      reason:
        'scheduler job tool approval requires an originating chat for this agent',
    };
  }

  return { ok: true, targetJid: requestedTargetJid };
}

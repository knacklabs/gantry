import type { AgentId } from '../domain/agent/agent.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';

export function resolveTaskAgentId(
  data: Parameters<TaskHandler>[0]['data'],
  sourceAgentFolder: string,
): AgentId {
  return (toTrimmedString(data.agentId, { maxLen: 512 }) ||
    memoryAgentIdForWorkspaceFolder(sourceAgentFolder)) as AgentId;
}

export function validateSameChannelApprovalTarget(input: {
  data: Parameters<TaskHandler>[0]['data'];
  sourceAgentFolderJids: string[];
  requestKind: string;
  reject: (error: string, code?: string, details?: string[]) => void;
}): string | null {
  const requestedTargetJid = toTrimmedString(input.data.chatJid, {
    maxLen: 512,
  });
  const targetOverride = toTrimmedString(
    input.data.targetJid || input.data.jid,
    {
      maxLen: 512,
    },
  );
  if (targetOverride && targetOverride !== requestedTargetJid) {
    input.reject(
      `${input.requestKind} requests must use the originating chat as the approval target.`,
      'forbidden',
    );
    return null;
  }
  if (
    !requestedTargetJid ||
    !input.sourceAgentFolderJids.includes(requestedTargetJid)
  ) {
    input.reject(
      `${input.requestKind} requests must include the originating chat for this agent.`,
      'forbidden',
    );
    return null;
  }
  return requestedTargetJid;
}

import { createHash } from 'node:crypto';

import type { PermissionApprovalRequest } from '../domain/types.js';

export function durablePermissionRequestSnapshot(
  request: PermissionApprovalRequest,
): Pick<
  PermissionApprovalRequest,
  | 'requestId'
  | 'appId'
  | 'agentId'
  | 'sourceAgentFolder'
  | 'runHandle'
  | 'jobId'
  | 'runId'
  | 'targetJid'
  | 'threadId'
  | 'toolName'
  | 'suggestions'
  | 'decisionOptions'
  | 'semanticCapabilityDefinitions'
> {
  return {
    requestId: request.requestId,
    ...(request.appId ? { appId: request.appId } : {}),
    ...(request.agentId ? { agentId: request.agentId } : {}),
    sourceAgentFolder: request.sourceAgentFolder,
    ...(request.runHandle ? { runHandle: request.runHandle } : {}),
    ...(request.jobId ? { jobId: request.jobId } : {}),
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.targetJid ? { targetJid: request.targetJid } : {}),
    ...(request.threadId ? { threadId: request.threadId } : {}),
    toolName: request.toolName,
    ...(request.suggestions ? { suggestions: request.suggestions } : {}),
    ...(request.decisionOptions
      ? { decisionOptions: request.decisionOptions }
      : {}),
    ...(request.semanticCapabilityDefinitions
      ? { semanticCapabilityDefinitions: request.semanticCapabilityDefinitions }
      : {}),
  };
}

export function durablePermissionCallbackId(requestId: string): string {
  return `p${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;
}

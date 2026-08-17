import type { AgentInput } from './agent-spawn-types.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import { createIpcAuthEnvelope } from './ipc-auth.js';
import {
  registerPermissionRunRestriction,
  unregisterPermissionRunRestriction,
} from './permission-decision-coordinator.js';

export function registerWorkerPermissionRunRestriction(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
  hideAuthorityTools: boolean;
  runKind: 'interactive' | 'scheduled';
  memoryUserId?: string;
  jobId?: string;
  runId?: string;
  toolPolicyRules?: readonly string[];
  semanticCapabilities?: readonly SemanticCapabilityDefinition[];
}): void {
  registerPermissionRunRestriction(input);
}

export function setupPermissionRunRestriction(
  sourceAgentFolder: string,
  agentInput: Pick<
    AgentInput,
    | 'threadId'
    | 'appId'
    | 'agentId'
    | 'isScheduledJob'
    | 'memoryUserId'
    | 'jobId'
    | 'runId'
    | 'toolPolicyRules'
    | 'semanticCapabilities'
  >,
  hideAuthorityTools: boolean,
) {
  const ipcAuth = createIpcAuthEnvelope(
    sourceAgentFolder,
    agentInput.threadId,
    {
      appId: agentInput.appId || 'default',
      agentId: agentInput.agentId,
    },
  );
  registerWorkerPermissionRunRestriction({
    sourceAgentFolder,
    responseKeyId: ipcAuth.responseKeyId,
    hideAuthorityTools,
    runKind: agentInput.isScheduledJob ? 'scheduled' : 'interactive',
    memoryUserId: agentInput.memoryUserId,
    jobId: agentInput.jobId,
    runId: agentInput.runId,
    toolPolicyRules: agentInput.toolPolicyRules,
    semanticCapabilities: agentInput.semanticCapabilities,
  });
  return {
    ipcAuth,
    unregisterPermissionRunRestriction: () =>
      unregisterPermissionRunRestriction({
        sourceAgentFolder,
        responseKeyId: ipcAuth.responseKeyId,
        runId: agentInput.runId,
      }),
  };
}

import type { AgentInput } from './agent-spawn-types.js';
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
  jobId?: string;
  runId?: string;
  personId?: string;
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
    | 'jobId'
    | 'runId'
    | 'memoryUserId'
    | 'actingPersonId'
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
    jobId: agentInput.jobId,
    runId: agentInput.runId,
    // Trusted acting person: a scheduled run carries it explicitly
    // (execution_context.personId); an interactive turn's memoryUserId IS the
    // resolved person. Host-set here, never from the worker's IPC payload.
    personId: agentInput.isScheduledJob
      ? agentInput.actingPersonId
      : agentInput.memoryUserId,
  });
  return {
    ipcAuth,
    unregisterPermissionRunRestriction: () =>
      unregisterPermissionRunRestriction({
        sourceAgentFolder,
        responseKeyId: ipcAuth.responseKeyId,
      }),
  };
}

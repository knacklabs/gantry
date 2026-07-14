import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import {
  applyPermissionInteractionDecision,
  recordPendingInteractionRequested,
  resolvePendingInteractionRecord,
} from './pending-interaction-durability.js';

export interface DurableInteractionOperations {
  record: typeof recordPendingInteractionRequested;
  resolve: typeof resolvePendingInteractionRecord;
}

const defaultOperations: DurableInteractionOperations = {
  record: recordPendingInteractionRequested,
  resolve: resolvePendingInteractionRecord,
};

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

export async function beginDurablePermissionInteraction(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  payload: Record<string, unknown>;
  callbackRoute?: Record<string, unknown> | null;
  operations?: DurableInteractionOperations;
}): Promise<void> {
  const recorded = await (input.operations ?? defaultOperations).record({
    kind: 'permission',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId,
    runId: input.request.runId,
    runLeaseToken: input.request.runLeaseToken,
    runLeaseFencingVersion: input.request.runLeaseFencingVersion,
    payload: input.payload,
    callbackRoute: input.callbackRoute,
  });
  if (!recorded) throw new Error('Permission prompt was not durably recorded');
}

export async function finishDurablePermissionInteraction(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  decision: PermissionApprovalDecision;
  updatedPermissions?: PermissionApprovalDecision['updatedPermissions'];
  operations?: DurableInteractionOperations;
}): Promise<boolean> {
  const applied = await applyPermissionInteractionDecision({
    request: input.request,
    sourceAgentFolder: input.sourceAgentFolder,
    decision: input.decision,
    appId: input.request.appId,
    runId: input.request.runId,
    runLeaseToken: input.request.runLeaseToken,
    runLeaseFencingVersion: input.request.runLeaseFencingVersion,
    toolName: input.request.toolName,
    requestId: input.request.requestId,
  });
  if (!applied) return false;
  return resolveDurablePermissionInteraction(input);
}

export function resolveDurablePermissionInteraction(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  decision: PermissionApprovalDecision;
  updatedPermissions?: PermissionApprovalDecision['updatedPermissions'];
  operations?: DurableInteractionOperations;
}): Promise<boolean> {
  return (input.operations ?? defaultOperations).resolve({
    kind: 'permission',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId ?? null,
    runId: input.request.runId ?? null,
    status: input.decision.mode === 'cancel' ? 'cancelled' : 'resolved',
    resolution: {
      approved: input.decision.approved,
      mode: input.decision.mode,
      reason: input.decision.reason ?? null,
      updatedPermissions: input.updatedPermissions ?? null,
      decisionClassification: input.decision.decisionClassification ?? null,
      timedGrantExpiresAtMs: input.decision.timedGrantExpiresAtMs ?? null,
    },
    approverRef: input.decision.decidedBy ?? null,
  });
}

export async function runDurablePermissionInteraction(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  prompt: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  beforePrompt?: () => Promise<void> | void;
  afterDecision?: (
    decision: PermissionApprovalDecision,
  ) => Promise<void> | void;
  operations?: DurableInteractionOperations;
}): Promise<{ decision: PermissionApprovalDecision; resolved: boolean }> {
  await beginDurablePermissionInteraction({
    request: input.request,
    sourceAgentFolder: input.sourceAgentFolder,
    operations: input.operations,
    payload: {
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      toolName: input.request.toolName,
      targetJid: input.request.targetJid ?? null,
      agentId: input.request.agentId ?? null,
      jobId: input.request.jobId ?? null,
      request: durablePermissionRequestSnapshot(input.request),
    },
    callbackRoute: null,
  });
  await input.beforePrompt?.();
  const decision = await input.prompt(input.request);
  await input.afterDecision?.(decision);
  const resolved = await finishDurablePermissionInteraction({
    request: input.request,
    sourceAgentFolder: input.sourceAgentFolder,
    decision,
    updatedPermissions: decision.updatedPermissions,
    operations: input.operations,
  });
  return { decision, resolved };
}

export async function beginDurableQuestionInteraction(input: {
  request: UserQuestionRequest;
  sourceAgentFolder: string;
  payload?: Record<string, unknown>;
  callbackRoute?: Record<string, unknown> | null;
  operations?: DurableInteractionOperations;
}): Promise<void> {
  const recorded = await (input.operations ?? defaultOperations).record({
    kind: 'question',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId ?? null,
    runId: input.request.runId ?? null,
    runLeaseToken: input.request.runLeaseToken ?? null,
    runLeaseFencingVersion: input.request.runLeaseFencingVersion ?? null,
    payload: input.payload ?? {
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      questions: input.request.questions.map((question) => question.question),
      targetJid: input.request.targetJid ?? null,
      agentId: input.request.agentId ?? null,
      jobId: input.request.jobId ?? null,
      request: input.request,
    },
    callbackRoute:
      input.callbackRoute === undefined
        ? {
            targetJid: input.request.targetJid ?? null,
            threadId: input.request.threadId ?? null,
          }
        : input.callbackRoute,
  });
  if (!recorded) throw new Error('Question prompt was not durably recorded');
}

export async function finishDurableQuestionInteraction(input: {
  request: UserQuestionRequest;
  sourceAgentFolder: string;
  response: UserQuestionResponse;
  operations?: DurableInteractionOperations;
}): Promise<boolean> {
  return (input.operations ?? defaultOperations).resolve({
    kind: 'question',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId ?? null,
    runId: input.request.runId ?? null,
    status: 'resolved',
    resolution: { answers: input.response.answers || {} },
    approverRef: input.response.answeredBy ?? null,
  });
}

export async function runDurableQuestionInteraction(input: {
  request: UserQuestionRequest;
  sourceAgentFolder: string;
  prompt: (request: UserQuestionRequest) => Promise<UserQuestionResponse>;
  beforePrompt?: () => Promise<void> | void;
  operations?: DurableInteractionOperations;
}): Promise<{ response: UserQuestionResponse; resolved: boolean }> {
  await beginDurableQuestionInteraction({ ...input, callbackRoute: null });
  await input.beforePrompt?.();
  const response = await input.prompt(input.request);
  const resolved = await finishDurableQuestionInteraction({
    request: input.request,
    sourceAgentFolder: input.sourceAgentFolder,
    response,
    operations: input.operations,
  });
  return { response, resolved };
}

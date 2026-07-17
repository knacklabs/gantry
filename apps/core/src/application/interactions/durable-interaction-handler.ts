import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  QuestionRecoveryEnvelope,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import {
  applyPermissionInteractionDecision,
  recordPendingInteractionRequested,
  releasePermissionInteractionCallback,
  resolvePendingInteractionRecord,
} from './pending-interaction-durability.js';
import { readQuestionRecoveryEnvelope } from './pending-interaction-prompt-binding.js';
import { durablePermissionRequestSnapshot } from './pending-interaction-permission-envelope.js';

export { durablePermissionRequestSnapshot } from './pending-interaction-permission-envelope.js';

export interface DurableInteractionOperations {
  record: typeof recordPendingInteractionRequested;
  resolve: typeof resolvePendingInteractionRecord;
}

const defaultOperations: DurableInteractionOperations = {
  record: recordPendingInteractionRequested,
  resolve: resolvePendingInteractionRecord,
};

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
  if (!applied) {
    await releaseDecisionClaim(input.decision);
    return false;
  }
  const resolved = await resolveDurablePermissionInteraction(input);
  return resolved || resolveDurablePermissionInteraction(input);
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
    },
    approverRef: input.decision.decidedBy ?? null,
    permissionCallbackClaim: input.decision.permissionCallbackClaim ?? null,
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
  try {
    await input.afterDecision?.(decision);
  } catch (err) {
    await releaseDecisionClaim(decision);
    throw err;
  }
  const resolved = await finishDurablePermissionInteraction({
    request: input.request,
    sourceAgentFolder: input.sourceAgentFolder,
    decision,
    updatedPermissions: decision.updatedPermissions,
    operations: input.operations,
  });
  return { decision, resolved };
}

async function releaseDecisionClaim(
  decision: PermissionApprovalDecision,
): Promise<void> {
  if (decision.permissionCallbackClaim) {
    await releasePermissionInteractionCallback({
      claim: decision.permissionCallbackClaim,
    });
  }
}

export async function beginDurableQuestionInteraction(input: {
  request: UserQuestionRequest;
  sourceAgentFolder: string;
  payload?: Record<string, unknown>;
  callbackRoute?: Record<string, unknown> | null;
  operations?: DurableInteractionOperations;
}): Promise<
  | {
      envelope: QuestionRecoveryEnvelope;
      status: 'pending' | 'resolved';
      answers: Record<string, string | string[]>;
      approverRef: string | null;
    }
  | undefined
> {
  const recorded = await (input.operations ?? defaultOperations).record({
    kind: 'question',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId ?? null,
    runId: input.request.runId ?? null,
    runLeaseToken: input.request.runLeaseToken ?? null,
    runLeaseFencingVersion: input.request.runLeaseFencingVersion ?? null,
    payload: {
      ...(input.payload ?? {
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.request.requestId,
        questions: input.request.questions.map((question) => question.question),
        targetJid: input.request.targetJid ?? null,
        agentId: input.request.agentId ?? null,
        jobId: input.request.jobId ?? null,
        request: input.request,
      }),
      questionRecoveryEnvelope: {
        version: 1,
        targetJid: input.request.targetJid ?? null,
        threadId: input.request.threadId ?? null,
        request: input.request,
        nextQuestionIndex: input.request.questions.length ? 0 : null,
        callbacks: {},
        selections: [],
        answers: {},
        completedQuestionIndexes: [],
        deliveredQuestionIndexes: [],
        otherPrompts: {},
      },
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
  if (typeof recorded === 'boolean') return undefined;
  const envelope = readQuestionRecoveryEnvelope(
    recorded.payload.questionRecoveryEnvelope,
  );
  const appId = input.request.appId || 'default';
  if (
    recorded.kind !== 'question' ||
    (recorded.status !== 'pending' && recorded.status !== 'resolved') ||
    recorded.appId !== appId ||
    !envelope ||
    envelope.request.requestId !== input.request.requestId ||
    envelope.request.sourceAgentFolder !== input.sourceAgentFolder ||
    (envelope.request.appId || 'default') !== appId ||
    (envelope.request.targetJid ?? null) !== envelope.targetJid ||
    (envelope.request.threadId ?? null) !== envelope.threadId
  ) {
    throw new Error('Durable question recovery envelope is missing or invalid');
  }
  const answers =
    recorded.status === 'resolved'
      ? readResolvedQuestionAnswers(recorded.resolution?.answers)
      : envelope.answers;
  if (!answers) {
    throw new Error(
      'Durable question recovery resolution is missing or invalid',
    );
  }
  return {
    envelope,
    status: recorded.status,
    answers,
    approverRef: recorded.approverRef,
  };
}

function readResolvedQuestionAnswers(
  value: unknown,
): Record<string, string | string[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    Object.values(value).some(
      (answer) =>
        typeof answer !== 'string' &&
        (!Array.isArray(answer) ||
          answer.some((entry) => typeof entry !== 'string')),
    )
  ) {
    return null;
  }
  return value as Record<string, string | string[]>;
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

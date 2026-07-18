import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import {
  applyPermissionInteractionDecision,
  cancelPendingQuestionInteractionIfRunLeaseInactive,
  recordPendingInteractionRequested,
  releasePermissionInteractionCallback,
  resolvePendingInteractionRecord,
} from './pending-interaction-durability.js';
import { durablePermissionRequestSnapshot } from './pending-interaction-permission-envelope.js';

export { durablePermissionRequestSnapshot } from './pending-interaction-permission-envelope.js';

export interface DurableInteractionOperations {
  record: typeof recordPendingInteractionRequested;
  resolve: typeof resolvePendingInteractionRecord;
  cancelPendingQuestionInteractionIfRunLeaseInactive: typeof cancelPendingQuestionInteractionIfRunLeaseInactive;
}

const defaultOperations: DurableInteractionOperations = {
  record: recordPendingInteractionRequested,
  resolve: resolvePendingInteractionRecord,
  cancelPendingQuestionInteractionIfRunLeaseInactive:
    cancelPendingQuestionInteractionIfRunLeaseInactive,
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
}): Promise<boolean> {
  const questionTexts = input.request.questions.map(
    (question) => question.question,
  );
  if (new Set(questionTexts).size !== questionTexts.length) {
    throw new Error(
      'ask_user_question requires unique question text; duplicate question labels are not allowed',
    );
  }
  const operations = input.operations ?? defaultOperations;
  const interactionId = globalThis.crypto.randomUUID();
  const recorded = await recordQuestionInteraction({
    ...input,
    interactionId,
    operations,
  });
  if (!recorded) throw new Error('Question prompt was not durably recorded');
  if (typeof recorded === 'boolean' || recorded.id === interactionId) {
    return true;
  }
  if (recorded.status === 'pending') {
    const terminalized =
      await operations.cancelPendingQuestionInteractionIfRunLeaseInactive({
        id: recorded.id,
        resolution: {
          answers: {},
          reason:
            'Runtime restarted while user question was pending; re-ask required.',
        },
      });
    if (!terminalized) return false;
    const reopened = await recordQuestionInteraction({
      ...input,
      interactionId,
      operations,
    });
    if (!reopened) throw new Error('Question prompt was not durably recorded');
    return typeof reopened !== 'boolean' && reopened.id === interactionId;
  }
  return false;
}

function recordQuestionInteraction(input: {
  interactionId: string;
  request: UserQuestionRequest;
  sourceAgentFolder: string;
  payload?: Record<string, unknown>;
  callbackRoute?: Record<string, unknown> | null;
  operations: DurableInteractionOperations;
}) {
  return input.operations.record({
    interactionId: input.interactionId,
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
}

export function finishDurableQuestionInteraction(input: {
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
    resolution: { answers: input.response.answers },
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
  const began = await beginDurableQuestionInteraction({
    ...input,
    callbackRoute: null,
  });
  if (!began) {
    return {
      response: {
        requestId: input.request.requestId,
        answers: {},
      },
      resolved: false,
    };
  }
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

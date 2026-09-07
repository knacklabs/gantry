import type {
  PendingInteractionRepository,
  PermissionPromptGroup,
} from '../../domain/ports/worker-coordination.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionCallbackScope,
  PermissionRecoveryEnvelope,
  PermissionRememberCode,
} from '../../domain/types.js';
import { parsePermissionRememberContext } from '../permissions/human-decision-learning.js';
import {
  durablePermissionRequestSnapshot,
  readDurablePermissionFullView,
  type DurablePermissionFullView,
} from './pending-interaction-permission-envelope.js';
import { DurableInteractionPersistenceError } from './pending-interaction-persistence-error.js';
import { pendingInteractionIdempotencyKey } from './pending-interaction-idempotency.js';

export { readDurablePermissionFullView } from './pending-interaction-permission-envelope.js';
export type { DurablePermissionFullView } from './pending-interaction-permission-envelope.js';
export { readQuestionRecoveryEnvelope } from './pending-interaction-question-recovery.js';
export type { DurableQuestionCallback } from './pending-interaction-question-recovery.js';

const DEFAULT_APP_ID = 'default';

type PromptBindingBackend = {
  repository: PendingInteractionRepository;
  warn?: (context: Record<string, unknown>, message: string) => void;
};

let backend: PromptBindingBackend | null = null;

export function configurePendingInteractionPromptBinding(
  next: PromptBindingBackend | null,
): void {
  backend = next;
}

export async function bindPendingPermissionInteractionMessage(input: {
  request: PermissionApprovalRequest;
  decisionOptions: (PermissionApprovalDecisionMode | PermissionRememberCode)[];
  callbackId?: string;
  externalMessageId?: string;
  provider?: string | null;
  conversationId?: string | null;
  fullView?: DurablePermissionFullView | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const { request } = input;
  const appId = request.appId || DEFAULT_APP_ID;
  const requestIds = request.permissionBatch?.requestIds?.length
    ? request.permissionBatch.requestIds
    : [request.requestId];
  const matchKind = requestIds.length > 1 ? 'batch' : 'individual';
  const envelope: PermissionRecoveryEnvelope = {
    version: 1,
    renderedDecisionOptions: [...input.decisionOptions],
    targetJid: request.targetJid ?? null,
    approvalContextJid: request.approvalContextJid ?? request.targetJid ?? null,
    threadId: request.threadId ?? null,
    decisionPolicy: request.decisionPolicy ?? null,
    renderedRequest: durablePermissionRequestSnapshot(request),
  };
  const callbackAlias =
    input.callbackId && input.callbackId !== request.requestId
      ? input.callbackId
      : null;
  const fullView = readDurablePermissionFullView(input.fullView);
  try {
    const group = await active.repository.bindPendingPermissionPrompt({
      id: globalThis.crypto.randomUUID(),
      appId,
      jobId: request.jobId ?? null,
      setupFingerprint: request.setupFingerprint ?? null,
      sourceAgentFolder: request.sourceAgentFolder,
      interactionId: request.requestId,
      matchKind,
      members: requestIds.map((requestId, index) => ({
        idempotencyKey: pendingInteractionIdempotencyKey({
          kind: 'permission',
          sourceAgentFolder: request.sourceAgentFolder,
          requestId,
          appId,
        }),
        requestId,
        index,
      })),
      envelope,
      fullView: fullView ? { ...fullView } : null,
      externalPromptProvider: input.provider ?? null,
      externalPromptConversationId: input.conversationId ?? null,
      externalPromptMessageId: input.externalMessageId ?? null,
      externalPromptThreadId: request.threadId ?? null,
      providerAliases: callbackAlias ? [callbackAlias] : [],
    });
    if (group && matchKind === 'batch') {
      for (const member of group.members ?? []) {
        if (!parsePermissionRememberContext(member.payload.rememberContext)) {
          continue;
        }
        const updated = await active.repository.updatePendingInteractionPayload(
          {
            idempotencyKey: member.idempotencyKey,
            update: (payload) => {
              const context = parsePermissionRememberContext(
                payload.rememberContext,
              );
              if (!context) return payload;
              return {
                ...payload,
                rememberContext: { ...context, eligible: false },
              };
            },
          },
        );
        if (!updated) return false;
      }
    }
    return group !== null;
  } catch (err) {
    active.warn?.(
      { err, requestId: request.requestId },
      'Failed to bind pending permission interaction to provider message',
    );
    throw new DurableInteractionPersistenceError(
      'Pending permission prompt binding could not be persisted',
      err,
    );
  }
}

export interface DurablePermissionPromptMessageContext {
  scope: PermissionCallbackScope;
  requestId: string;
  matchKind: 'individual' | 'batch';
  providerAlias: string | null;
  sourceAgentFolder: string;
  targetJid: string | null;
  approvalContextJid: string | null;
  threadId: string | null;
  decisionPolicy: PermissionApprovalRequest['decisionPolicy'] | null;
  decisionOptions: (PermissionApprovalDecisionMode | PermissionRememberCode)[];
  request: PermissionApprovalRequest;
  claim?: NonNullable<PermissionPromptGroup['prompt']['claim']>;
}

export async function findDurablePermissionInteractionByPromptMessage(input: {
  provider: string;
  conversationId: string;
  externalMessageId: string;
  threadId?: string | null;
  appId?: string | null;
  providerAlias?: string;
}): Promise<DurablePermissionPromptMessageContext | null> {
  const active = backend;
  if (!active) return null;
  const appId = input.appId || DEFAULT_APP_ID;
  try {
    const group = await active.repository.findPendingPermissionPromptByMessage({
      appId,
      provider: input.provider,
      conversationId: input.conversationId,
      externalMessageId: input.externalMessageId,
      threadId: input.threadId ?? null,
    });
    if (!group) return null;
    const { prompt } = group;
    const aliases = prompt.claim?.match.providerAliases.length
      ? prompt.claim.match.providerAliases
      : prompt.providerAliases;
    if (input.providerAlias && !aliases.includes(input.providerAlias)) {
      return null;
    }
    return {
      scope: {
        appId: prompt.appId,
        sourceAgentFolder: prompt.sourceAgentFolder,
        interactionId: prompt.interactionId,
      },
      requestId: prompt.interactionId,
      matchKind: prompt.matchKind,
      providerAlias: input.providerAlias ?? aliases[0] ?? null,
      sourceAgentFolder: prompt.sourceAgentFolder,
      targetJid: prompt.envelope.targetJid,
      approvalContextJid: prompt.envelope.approvalContextJid,
      threadId: prompt.envelope.threadId,
      decisionPolicy: prompt.envelope.decisionPolicy,
      decisionOptions: prompt.envelope.renderedDecisionOptions,
      request: prompt.envelope.renderedRequest,
      ...(prompt.claim ? { claim: prompt.claim } : {}),
    };
  } catch (err) {
    active.warn?.(
      { err, externalMessageId: input.externalMessageId },
      'Failed to find durable permission interaction by provider message',
    );
    return null;
  }
}

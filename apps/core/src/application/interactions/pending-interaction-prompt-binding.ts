import type {
  PendingInteractionKind,
  PendingInteractionRepository,
} from '../../domain/ports/worker-coordination.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackScope,
  PermissionRecoveryEnvelope,
} from '../../domain/types.js';
import {
  permissionRequestFromPayload,
  readDurablePermissionFullView,
  readPermissionCallbackClaim,
  readPermissionRecoveryEnvelope,
  samePermissionCallbackClaim,
  sharedPermissionRecoveryEnvelope,
  durablePermissionRequestSnapshot,
  type DurablePermissionFullView,
} from './pending-interaction-permission-envelope.js';
import { DurableInteractionPersistenceError } from './pending-interaction-persistence-error.js';
import {
  createDurableQuestionCallback,
  questionCallback,
  questionCallbacks,
  readQuestionRecoveryEnvelope,
  type DurableQuestionCallback,
  type DurableQuestionCallbackContext,
} from './pending-interaction-question-recovery.js';

export {
  readDurablePermissionFullView,
  readPermissionRecoveryEnvelope,
  sharedPermissionRecoveryEnvelope,
} from './pending-interaction-permission-envelope.js';
export type { DurablePermissionFullView } from './pending-interaction-permission-envelope.js';
export {
  createDurableQuestionCallback,
  readQuestionRecoveryEnvelope,
} from './pending-interaction-question-recovery.js';
export type {
  DurableQuestionCallback,
  DurableQuestionCallbackContext,
} from './pending-interaction-question-recovery.js';

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

function idempotencyKey(input: {
  kind: PendingInteractionKind;
  sourceAgentFolder: string;
  requestId: string;
  appId?: string | null;
}): string {
  return [
    input.appId || DEFAULT_APP_ID,
    input.kind,
    input.sourceAgentFolder,
    input.requestId,
  ].join(':');
}

function sourceAgentFolderFromPayload(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (typeof payload?.sourceAgentFolder === 'string')
    return payload.sourceAgentFolder;
  const request = payload?.request;
  if (!request || typeof request !== 'object') return null;
  if (!('sourceAgentFolder' in request)) return null;
  return typeof request.sourceAgentFolder === 'string'
    ? request.sourceAgentFolder
    : null;
}

export async function bindPendingPermissionInteractionMessage(input: {
  request: PermissionApprovalRequest;
  decisionOptions: PermissionApprovalDecisionMode[];
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
  const keys = new Set(
    requestIds.map((requestId) =>
      idempotencyKey({
        kind: 'permission',
        sourceAgentFolder: request.sourceAgentFolder,
        requestId,
        appId,
      }),
    ),
  );
  try {
    const pending = (
      await active.repository.listPendingInteractions({
        appId,
      })
    ).filter(
      (interaction) =>
        interaction.kind === 'permission' &&
        interaction.status === 'pending' &&
        keys.has(interaction.idempotencyKey),
    );
    if (pending.length !== keys.size) return false;
    const pendingByRequestId = new Map(
      pending.map((interaction) => [
        interaction.payload.requestId,
        interaction,
      ]),
    );
    const orderedPending = requestIds.map((requestId) =>
      pendingByRequestId.get(requestId),
    );
    if (orderedPending.some((interaction) => !interaction)) return false;
    const members = orderedPending.map((interaction, index) => {
      const memberRequest = permissionRequestFromPayload(interaction!.payload);
      if (
        !memberRequest ||
        memberRequest.requestId !== requestIds[index] ||
        memberRequest.sourceAgentFolder !== request.sourceAgentFolder
      ) {
        return null;
      }
      return {
        callback: {
          appId,
          sourceAgentFolder: request.sourceAgentFolder,
          requestId: memberRequest.requestId,
          index,
        },
        request: durablePermissionRequestSnapshot(memberRequest),
      };
    });
    if (members.some((member) => !member)) return false;
    const recoveryEnvelope: PermissionRecoveryEnvelope = {
      version: 1,
      renderedDecisionOptions: [...input.decisionOptions],
      targetJid: request.targetJid ?? null,
      approvalContextJid:
        request.approvalContextJid ?? request.targetJid ?? null,
      threadId: request.threadId ?? null,
      decisionPolicy: request.decisionPolicy ?? null,
      renderedRequest: durablePermissionRequestSnapshot(request),
      members: members as PermissionRecoveryEnvelope['members'],
      batch:
        members.length > 1
          ? {
              canonicalId: request.requestId,
              phase: 'decision',
            }
          : null,
    };
    const fullView = readDurablePermissionFullView(input.fullView);
    const callbackAlias =
      input.callbackId && input.callbackId !== request.requestId
        ? input.callbackId
        : null;
    const bindingPayload = {
      ...(input.externalMessageId
        ? { externalPromptMessageId: input.externalMessageId }
        : {}),
      ...(input.provider ? { externalPromptProvider: input.provider } : {}),
      ...(input.conversationId
        ? { externalPromptConversationId: input.conversationId }
        : {}),
      ...(request.threadId ? { externalPromptThreadId: request.threadId } : {}),
      ...(callbackAlias ? { permissionCallbackId: callbackAlias } : {}),
      ...(requestIds.length > 1
        ? {
            permissionBatchRequestIds: requestIds,
            permissionBatchCallbackId: request.requestId,
          }
        : {}),
      permissionRecoveryEnvelope: recoveryEnvelope,
      ...(fullView ? { permissionFullView: fullView } : {}),
    };
    const updated = await Promise.all(
      pending.map((interaction) =>
        active.repository.updatePendingInteractionPayload({
          idempotencyKey: interaction.idempotencyKey,
          update: (payload) => {
            if ('permissionCallbackClaim' in payload) return null;
            const next = { ...payload, ...bindingPayload };
            const settlement = readPermissionCallbackClaim(
              payload.permissionCallbackSettlement,
            );
            if (
              requestIds.length > 1 &&
              settlement?.match.canonicalId === request.requestId
            ) {
              delete next.permissionBatchCallbackId;
              delete next.permissionCallbackId;
              if (
                !('permissionBatchCallbackId' in payload) &&
                typeof payload.permissionCallbackId === 'string'
              ) {
                next.permissionCallbackId = payload.permissionCallbackId;
              }
              return next;
            }
            if (requestIds.length === 1) {
              delete next.permissionBatchCallbackId;
              delete next.permissionBatchRequestIds;
            }
            if (!callbackAlias) delete next.permissionCallbackId;
            return next;
          },
        }),
      ),
    );
    return updated.every(Boolean);
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

export async function bindPendingQuestionInteractionCallback(input: {
  sourceAgentFolder: string;
  requestId: string;
  callbackId: string;
  questionIndex: number;
  appId?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const key = idempotencyKey({
    kind: 'question',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.requestId,
    appId: input.appId,
  });
  try {
    const pending = (
      await active.repository.listPendingInteractions({
        appId: input.appId || DEFAULT_APP_ID,
      })
    ).find(
      (interaction) =>
        interaction.kind === 'question' &&
        interaction.status === 'pending' &&
        interaction.idempotencyKey === key,
    );
    if (!pending) return false;
    return await active.repository.updatePendingInteractionPayload({
      idempotencyKey: key,
      update: (payload) => {
        const envelope = readQuestionRecoveryEnvelope(
          payload.questionRecoveryEnvelope,
        );
        if (!envelope) return null;
        const callbacks = questionCallbacks(envelope.callbacks);
        callbacks[input.callbackId] = {
          appId: input.appId || DEFAULT_APP_ID,
          sourceAgentFolder: input.sourceAgentFolder,
          requestId: input.requestId,
          questionIndex: input.questionIndex,
        };
        return {
          ...payload,
          questionRecoveryEnvelope: { ...envelope, callbacks },
        };
      },
    });
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId, callbackId: input.callbackId },
      'Failed to bind pending question interaction callback',
    );
    throw new DurableInteractionPersistenceError(
      'Pending question callback binding could not be persisted',
      err,
    );
  }
}

export async function findDurableQuestionInteractionByCallbackId(input: {
  callbackId: string;
  appId?: string | null;
  scope?: DurableQuestionCallback['scope'];
  questionIndex?: number;
}): Promise<DurableQuestionCallbackContext | null> {
  const active = backend;
  if (!active) return null;
  const appId = input.scope?.appId || input.appId || DEFAULT_APP_ID;
  try {
    const pending = (
      await active.repository.listPendingInteractions({
        appId,
      })
    ).find((interaction) => {
      const callback = questionCallback(
        readQuestionRecoveryEnvelope(
          interaction.payload.questionRecoveryEnvelope,
        )?.callbacks,
        input.callbackId,
      );
      return (
        interaction.kind === 'question' &&
        interaction.status === 'pending' &&
        callback?.appId === appId &&
        interaction.idempotencyKey ===
          idempotencyKey({
            kind: 'question',
            sourceAgentFolder: callback.sourceAgentFolder,
            requestId: callback.requestId,
            appId: callback.appId,
          }) &&
        (!input.scope ||
          (callback.sourceAgentFolder === input.scope.sourceAgentFolder &&
            callback.requestId === input.scope.interactionId)) &&
        (input.questionIndex === undefined ||
          callback.questionIndex === input.questionIndex)
      );
    });
    return pending
      ? questionCallback(
          readQuestionRecoveryEnvelope(pending.payload.questionRecoveryEnvelope)
            ?.callbacks,
          input.callbackId,
        )
      : null;
  } catch (err) {
    active.warn?.(
      { err, callbackId: input.callbackId },
      'Failed to find durable question interaction callback',
    );
    return null;
  }
}

export async function bindPendingQuestionOtherPrompt(input: {
  callback: DurableQuestionCallback;
  promptId: string;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const { scope } = input.callback;
  const key = idempotencyKey({
    kind: 'question',
    sourceAgentFolder: scope.sourceAgentFolder,
    requestId: scope.interactionId,
    appId: scope.appId,
  });
  try {
    const pending = (
      await active.repository.listPendingInteractions({ appId: scope.appId })
    ).find(
      (interaction) =>
        interaction.kind === 'question' &&
        interaction.status === 'pending' &&
        interaction.idempotencyKey === key,
    );
    if (!pending) return false;
    return await active.repository.updatePendingInteractionPayload({
      idempotencyKey: key,
      update: (payload) => {
        const envelope = readQuestionRecoveryEnvelope(
          payload.questionRecoveryEnvelope,
        );
        if (!envelope) return null;
        return {
          ...payload,
          questionRecoveryEnvelope: {
            ...envelope,
            otherPrompts: {
              ...envelope.otherPrompts,
              [input.promptId]: {
                appId: scope.appId,
                sourceAgentFolder: scope.sourceAgentFolder,
                requestId: scope.interactionId,
                questionIndex: input.callback.questionIndex,
              },
            },
          },
        };
      },
    });
  } catch (err) {
    active.warn?.(
      { err, requestId: scope.interactionId, promptId: input.promptId },
      'Failed to bind pending question other prompt',
    );
    throw new DurableInteractionPersistenceError(
      'Pending question other-prompt binding could not be persisted',
      err,
    );
  }
}

export async function findDurableQuestionOtherPrompt(input: {
  appId?: string | null;
  promptId: string;
}): Promise<DurableQuestionCallbackContext | null> {
  const active = backend;
  if (!active) return null;
  const appId = input.appId || DEFAULT_APP_ID;
  const pending = (
    await active.repository.listPendingInteractions({ appId })
  ).find((interaction) => {
    const envelope = readQuestionRecoveryEnvelope(
      interaction.payload.questionRecoveryEnvelope,
    );
    return (
      interaction.kind === 'question' &&
      interaction.status === 'pending' &&
      Boolean(envelope?.otherPrompts[input.promptId])
    );
  });
  const envelope = readQuestionRecoveryEnvelope(
    pending?.payload.questionRecoveryEnvelope,
  );
  return envelope?.otherPrompts[input.promptId] ?? null;
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
  decisionOptions: PermissionApprovalDecisionMode[];
  request: PermissionApprovalRequest;
  claim?: PermissionCallbackClaim;
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
    const pending = (
      await active.repository.listPendingInteractions({
        appId,
      })
    ).filter((interaction) => {
      if (interaction.kind !== 'permission' || interaction.status !== 'pending')
        return false;
      const payload = interaction.payload;
      if (payload.externalPromptProvider !== input.provider) return false;
      if (payload.externalPromptConversationId !== input.conversationId)
        return false;
      if (payload.externalPromptMessageId !== input.externalMessageId)
        return false;
      const threadId =
        typeof payload.externalPromptThreadId === 'string'
          ? payload.externalPromptThreadId
          : null;
      return threadId === (input.threadId ?? null);
    });
    if (pending.length === 0) return null;
    const envelope = sharedPermissionRecoveryEnvelope(pending);
    if (!envelope) return null;
    const sourceAgentFolder = envelope.members[0]!.callback.sourceAgentFolder;
    const claims = pending.map((interaction) =>
      readPermissionCallbackClaim(interaction.payload.permissionCallbackClaim),
    );
    const persistedClaim = claims.find((claim) => claim !== null) ?? null;
    let scope: PermissionCallbackScope;
    let matchKind: 'individual' | 'batch';
    let providerAlias: string | null;
    let claimForContext: PermissionCallbackClaim | null = null;
    if (persistedClaim) {
      if (
        input.providerAlias ||
        claims.some(
          (claim) =>
            !claim || !samePermissionCallbackClaim(claim, persistedClaim),
        ) ||
        pending.some(
          (interaction) =>
            typeof interaction.payload.permissionCallbackId === 'string' ||
            typeof interaction.payload.permissionBatchCallbackId === 'string',
        ) ||
        persistedClaim.scope.appId !== appId ||
        persistedClaim.scope.sourceAgentFolder !== sourceAgentFolder ||
        persistedClaim.match.canonicalId !==
          persistedClaim.scope.interactionId ||
        (persistedClaim.match.kind === 'individual' && pending.length !== 1)
      ) {
        return null;
      }
      scope = persistedClaim.scope;
      matchKind = persistedClaim.match.kind;
      providerAlias = null;
      claimForContext = {
        ...persistedClaim,
        match: {
          ...persistedClaim.match,
          providerAliases: [
            ...new Set(
              claims.flatMap((claim) => claim?.match.providerAliases ?? []),
            ),
          ],
        },
      };
    } else {
      if (claims.some((claim) => claim !== null)) return null;
      const activeAliases = pending.map((interaction) =>
        typeof interaction.payload.permissionCallbackId === 'string'
          ? interaction.payload.permissionCallbackId
          : null,
      );
      if (
        input.providerAlias &&
        activeAliases.some((alias) => alias !== input.providerAlias)
      ) {
        return null;
      }
      const batchMarkers = pending.map((interaction) =>
        typeof interaction.payload.permissionBatchCallbackId === 'string'
          ? interaction.payload.permissionBatchCallbackId
          : null,
      );
      const actualBatchMarkers = new Set(
        batchMarkers.filter((marker): marker is string => marker !== null),
      );
      let interactionId: string;
      if (actualBatchMarkers.size > 0) {
        if (actualBatchMarkers.size !== 1 || batchMarkers.some((id) => !id)) {
          return null;
        }
        interactionId = [...actualBatchMarkers][0]!;
        matchKind = 'batch';
      } else {
        if (pending.length !== 1) return null;
        const requestId = pending[0]!.payload.requestId;
        if (typeof requestId !== 'string') return null;
        interactionId = requestId;
        matchKind = 'individual';
      }
      scope = { appId, sourceAgentFolder, interactionId };
      providerAlias = input.providerAlias ?? activeAliases[0] ?? null;
    }
    return {
      scope,
      requestId: scope.interactionId,
      matchKind,
      providerAlias,
      sourceAgentFolder,
      targetJid: envelope.targetJid,
      approvalContextJid: envelope.approvalContextJid,
      threadId: envelope.threadId,
      decisionPolicy: envelope.decisionPolicy,
      decisionOptions: envelope.renderedDecisionOptions,
      request: envelope.renderedRequest,
      ...(claimForContext ? { claim: claimForContext } : {}),
    };
  } catch (err) {
    active.warn?.(
      { err, externalMessageId: input.externalMessageId },
      'Failed to find durable permission interaction by provider message',
    );
    return null;
  }
}

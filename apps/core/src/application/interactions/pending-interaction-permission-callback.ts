import type {
  PendingInteraction,
  PendingInteractionRepository,
} from '../../domain/ports/worker-coordination.js';
import { decisionForMode } from '../../domain/permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
  PermissionCallbackScope,
  PermissionRecoveryEnvelope,
} from '../../domain/types.js';
import type { PermissionInteractionDecisionInput } from './pending-interaction-grants.js';
import {
  readDurablePermissionFullView,
  readPermissionRecoveryEnvelope,
  sharedPermissionRecoveryEnvelope,
  type DurablePermissionFullView,
} from './pending-interaction-prompt-binding.js';
import {
  isAllowedPermissionApproverIdentity,
  permissionCallbackClaimFromPayload,
  permissionCallbackClaimFromValue,
  permissionClaimReference,
  samePermissionClaim,
  samePersistedPermissionClaim,
  sourceAgentFolderFromPermissionPayload,
} from './pending-interaction-permission-claim.js';

interface PermissionCallbackBackend {
  repository: PendingInteractionRepository;
  applyDecision: (
    input: PermissionInteractionDecisionInput,
  ) => Promise<boolean>;
  resolve: (input: {
    kind: 'permission';
    sourceAgentFolder: string;
    requestId: string;
    appId: string;
    runId?: string | null;
    status: 'resolved' | 'cancelled';
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    permissionCallbackClaim: PermissionCallbackClaimReference;
  }) => Promise<boolean>;
  warn?: (context: Record<string, unknown>, message: string) => void;
}

export async function replayPersistedPermissionDecisionForRequest(input: {
  appId?: string | null;
  sourceAgentFolder: string;
  requestId: string;
}): Promise<PermissionApprovalDecision | null> {
  const active = backend;
  if (!active) return null;
  const appId = input.appId || 'default';
  try {
    const pending = await active.repository.listPendingInteractions({ appId });
    const member = pending.find(
      (interaction) =>
        interaction.kind === 'permission' &&
        interaction.status === 'pending' &&
        interaction.payload.requestId === input.requestId &&
        sourceAgentFolderFromPermissionPayload(interaction.payload) ===
          input.sourceAgentFolder,
    );
    if (!member) return null;
    const persistedClaim = permissionCallbackClaimFromPayload(member.payload);
    const settledClaim = permissionCallbackClaimFromValue(
      member.payload.permissionCallbackSettlement,
    );
    const claim = persistedClaim ?? settledClaim;
    const hasClaimState =
      'permissionCallbackClaim' in member.payload ||
      'permissionCallbackSettlement' in member.payload;
    if (hasClaimState && !claim) {
      throw new Error('Persisted permission claim is malformed');
    }
    if (!claim) return null;
    const envelope = readPermissionRecoveryEnvelope(
      member.payload.permissionRecoveryEnvelope,
    );
    if (!envelope) {
      throw new Error('Persisted permission recovery envelope is malformed');
    }
    if (
      !persistedClaim &&
      settledClaim &&
      settledClaim.match.kind !== (envelope.batch ? 'batch' : 'individual')
    ) {
      return null;
    }
    if (
      claim.scope.appId !== appId ||
      claim.scope.sourceAgentFolder !== input.sourceAgentFolder
    ) {
      throw new Error(
        'Persisted permission claim scope does not match request',
      );
    }
    const persistedMember = envelope.members.find(
      (candidate) => candidate.callback.requestId === input.requestId,
    );
    if (!persistedMember) {
      throw new Error(
        'Persisted permission member is missing from recovery envelope',
      );
    }
    if (
      claim.match.kind === 'batch' &&
      claim.intent.mode === 'allow_persistent_rule'
    ) {
      if (envelope.batch?.phase !== 'review_each') {
        throw new Error('Persisted review-each claim has no review-each phase');
      }
      const rows = pending.filter(
        (interaction) =>
          interaction.kind === 'permission' &&
          interaction.status === 'pending' &&
          JSON.stringify(interaction.payload.permissionRecoveryEnvelope) ===
            JSON.stringify(envelope),
      );
      const decision = (
        await replayPersistedReviewEach({
          claim,
          envelope,
          interactions: rows,
          claimIsActive: Boolean(persistedClaim),
        })
      ).get(input.requestId);
      if (!decision) {
        throw new Error('Persisted review-each member was not dispatched');
      }
      return decision;
    }
    return recoveredPermissionDecision({
      request: persistedMember.request,
      claim,
    });
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to replay persisted permission decision',
    );
    throw err;
  }
}

async function replayPersistedReviewEach(input: {
  claim: PermissionCallbackClaim;
  envelope: PermissionRecoveryEnvelope;
  interactions: PendingInteraction[];
  claimIsActive: boolean;
}): Promise<Map<string, PermissionApprovalDecision>> {
  const dispatcher = reviewEachDispatcher;
  if (!dispatcher || input.envelope.batch?.phase !== 'review_each') {
    return new Map();
  }
  const key = [
    input.claim.scope.appId,
    input.claim.scope.sourceAgentFolder,
    input.claim.scope.interactionId,
    input.claim.id,
  ].join(':');
  const existing = reviewEachReplays.get(key);
  if (existing) return existing;
  const replay = (async () => {
    if (
      input.claimIsActive &&
      !(await settlePermissionInteractionCallback({
        claim: permissionClaimReference(input.claim),
      }))
    ) {
      return new Map<string, PermissionApprovalDecision>();
    }
    const pendingRequestIds = new Set(
      input.interactions.map((interaction) => interaction.payload.requestId),
    );
    const decisions = new Map<string, PermissionApprovalDecision>();
    for (const member of input.envelope.members) {
      if (!pendingRequestIds.has(member.callback.requestId)) continue;
      const interaction = input.interactions.find(
        (candidate) =>
          candidate.payload.requestId === member.callback.requestId,
      );
      const rowClaim = interaction
        ? (permissionCallbackClaimFromPayload(interaction.payload) ??
          permissionCallbackClaimFromValue(
            interaction.payload.permissionCallbackSettlement,
          ))
        : null;
      const existingMemberClaim =
        rowClaim?.match.kind === 'individual' ? rowClaim : null;
      if (
        rowClaim &&
        !existingMemberClaim &&
        (rowClaim.id !== input.claim.id || rowClaim.match.kind !== 'batch')
      ) {
        throw new Error('Persisted review-each member claim is malformed');
      }
      if (existingMemberClaim) {
        if (
          existingMemberClaim.scope.appId !== member.callback.appId ||
          existingMemberClaim.scope.sourceAgentFolder !==
            member.callback.sourceAgentFolder ||
          existingMemberClaim.scope.interactionId !== member.callback.requestId
        ) {
          throw new Error('Persisted review-each member claim is malformed');
        }
        decisions.set(
          member.callback.requestId,
          recoveredPermissionDecision({
            request: member.request,
            claim: existingMemberClaim,
          }),
        );
        continue;
      }
      const dispatched = await dispatcher(member.request);
      if (!dispatched.delivered) {
        throw new Error(
          `Recovered review-each member prompt was not delivered: ${dispatched.reason}`,
        );
      }
      decisions.set(member.callback.requestId, dispatched.decision);
    }
    return decisions;
  })();
  reviewEachReplays.set(key, replay);
  void replay.catch(() => reviewEachReplays.delete(key));
  return replay;
}

let backend: PermissionCallbackBackend | null = null;
export type PermissionReviewEachDispatchResult =
  | { delivered: true; decision: PermissionApprovalDecision }
  | { delivered: false; reason: string };
let reviewEachDispatcher:
  | ((
      request: PermissionApprovalRequest,
    ) => Promise<PermissionReviewEachDispatchResult>)
  | null = null;
const reviewEachReplays = new Map<
  string,
  Promise<Map<string, PermissionApprovalDecision>>
>();

export function configurePendingInteractionPermissionCallbacks(
  next: PermissionCallbackBackend | null,
): void {
  backend = next;
  if (!next) reviewEachReplays.clear();
}

export function configurePermissionReviewEachDispatcher(
  dispatcher:
    | ((
        request: PermissionApprovalRequest,
      ) => Promise<PermissionReviewEachDispatchResult>)
    | null,
): void {
  reviewEachDispatcher = dispatcher;
  reviewEachReplays.clear();
}

export interface DurablePermissionInteractionContext {
  scope: PermissionCallbackScope;
  requestId: string;
  batchCallbackId: string | null;
  sourceAgentFolder: string;
  targetJid: string | null;
  approvalContextJid: string | null;
  threadId: string | null;
  decisionPolicy: PermissionApprovalRequest['decisionPolicy'] | null;
  decisionOptions: PermissionApprovalDecisionMode[];
  externalPromptMessageId: string | null;
  externalPromptProvider: string | null;
  externalPromptConversationId: string | null;
  externalPromptThreadId: string | null;
  providerAliases: string[];
  request: PermissionApprovalRequest;
  claim?: PermissionCallbackClaim;
  fullView?: DurablePermissionFullView;
}

export async function findDurablePermissionInteractionByRequestId(input: {
  scope: PermissionCallbackScope;
  providerAlias?: string;
}): Promise<DurablePermissionInteractionContext | null> {
  const active = backend;
  if (!active) return null;
  try {
    const pending = await active.repository.findPendingPermissionInteractions({
      scope: input.scope,
    });
    if (pending.length === 0) return null;
    const envelope = sharedPermissionRecoveryEnvelope(pending);
    if (!envelope) return null;
    const first = pending[0]!;
    const sourceAgentFolder = envelope.members[0]!.callback.sourceAgentFolder;
    if (sourceAgentFolder !== input.scope.sourceAgentFolder) return null;
    const fullView = readDurablePermissionFullView(
      first.payload.permissionFullView,
    );
    const claims = pending.map((interaction) =>
      permissionCallbackClaimFromPayload(interaction.payload),
    );
    const claim = claims.find((value) => value !== null) ?? null;
    if (
      claim &&
      claims.some(
        (value) => !value || !samePersistedPermissionClaim(value, claim),
      )
    ) {
      return null;
    }
    const providerAliases = [
      ...new Set(
        pending.flatMap((interaction) =>
          typeof interaction.payload.permissionCallbackId === 'string'
            ? [interaction.payload.permissionCallbackId]
            : [],
        ),
      ),
    ];
    if (input.providerAlias && !providerAliases.includes(input.providerAlias)) {
      return null;
    }
    return {
      scope: input.scope,
      requestId: input.scope.interactionId,
      batchCallbackId:
        claim?.match.kind === 'batch' ||
        first.payload.permissionBatchCallbackId === input.scope.interactionId
          ? input.scope.interactionId
          : null,
      sourceAgentFolder,
      targetJid: envelope.targetJid,
      approvalContextJid: envelope.approvalContextJid,
      threadId: envelope.threadId,
      decisionPolicy: envelope.decisionPolicy,
      decisionOptions: envelope.renderedDecisionOptions,
      externalPromptMessageId:
        typeof first.payload.externalPromptMessageId === 'string'
          ? first.payload.externalPromptMessageId
          : null,
      externalPromptProvider:
        typeof first.payload.externalPromptProvider === 'string'
          ? first.payload.externalPromptProvider
          : null,
      externalPromptConversationId:
        typeof first.payload.externalPromptConversationId === 'string'
          ? first.payload.externalPromptConversationId
          : null,
      externalPromptThreadId:
        typeof first.payload.externalPromptThreadId === 'string'
          ? first.payload.externalPromptThreadId
          : null,
      providerAliases,
      request: envelope.renderedRequest,
      ...(claim ? { claim } : {}),
      ...(fullView ? { fullView } : {}),
    };
  } catch (err) {
    active.warn?.(
      { err, scope: input.scope },
      'Failed to find durable permission interaction',
    );
    return null;
  }
}

export type PermissionCallbackClaimResult =
  | {
      status: 'claimed';
      claim: PermissionCallbackClaimReference;
    }
  | { status: 'already_decided'; ownerless?: true }
  | { status: 'retryable' };

export async function claimPermissionInteractionCallback(input: {
  scope: PermissionCallbackScope;
  mode: PermissionCallbackClaim['intent']['mode'];
  approverRef: string;
  matchKind: PermissionCallbackClaim['match']['kind'];
  providerAlias?: string;
  claimedAt?: string;
  claimId?: string;
}): Promise<PermissionCallbackClaimResult> {
  const active = backend;
  if (
    !active ||
    !isAllowedPermissionApproverIdentity(input.mode, input.approverRef)
  ) {
    return { status: 'retryable' };
  }
  const claim: PermissionCallbackClaim = {
    id: input.claimId ?? globalThis.crypto.randomUUID(),
    scope: input.scope,
    intent: {
      mode: input.mode,
      approverRef: input.approverRef,
      decidedAt: input.claimedAt ?? new Date().toISOString(),
    },
    match: {
      kind: input.matchKind,
      canonicalId: input.scope.interactionId,
      providerAliases: input.providerAlias ? [input.providerAlias] : [],
    },
  };
  try {
    const claimed = await active.repository.claimPendingPermissionCallback({
      claim,
    });
    if (claimed.length > 0) {
      return { status: 'claimed', claim: permissionClaimReference(claim) };
    }
    const current = await active.repository.findPendingPermissionInteractions({
      scope: input.scope,
      includeTerminalSettlement: true,
    });
    const hasHolder = current.some((interaction) => {
      const holder = permissionCallbackClaimFromPayload(interaction.payload);
      return (
        holder?.scope.appId === input.scope.appId &&
        holder.scope.sourceAgentFolder === input.scope.sourceAgentFolder &&
        holder.scope.interactionId === input.scope.interactionId
      );
    });
    if (hasHolder) {
      return { status: 'already_decided' };
    }
    if (current.length === 0) {
      return input.mode === 'cancel' && input.approverRef === 'system'
        ? { status: 'already_decided', ownerless: true }
        : { status: 'already_decided' };
    }
    const hasTerminalSettlement = current.some((interaction) => {
      const settlement = permissionCallbackClaimFromValue(
        interaction.payload.permissionCallbackSettlement,
      );
      const envelope = readPermissionRecoveryEnvelope(
        interaction.payload.permissionRecoveryEnvelope,
      );
      return (
        settlement?.scope.appId === input.scope.appId &&
        settlement.scope.sourceAgentFolder === input.scope.sourceAgentFolder &&
        settlement.scope.interactionId === input.scope.interactionId &&
        settlement.match.kind === (envelope?.batch ? 'batch' : 'individual')
      );
    });
    return {
      status: hasTerminalSettlement ? 'already_decided' : 'retryable',
    };
  } catch (err) {
    active.warn?.(
      { err, scope: input.scope },
      'Failed to claim durable permission callback',
    );
    return { status: 'retryable' };
  }
}

export async function releasePermissionInteractionCallback(input: {
  claim: PermissionCallbackClaimReference;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  try {
    return (
      (await active.repository.releasePendingPermissionCallback({
        claim: input.claim,
      })) > 0
    );
  } catch (err) {
    active.warn?.(
      { err, claim: input.claim },
      'Failed to release durable permission callback claim',
    );
    return false;
  }
}

export async function settlePermissionInteractionCallback(input: {
  claim: PermissionCallbackClaimReference;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  try {
    return (
      (await active.repository.settlePendingPermissionCallback({
        claim: input.claim,
      })) > 0
    );
  } catch (err) {
    active.warn?.(
      { err, claim: input.claim },
      'Failed to settle durable permission callback claim',
    );
    return false;
  }
}

export async function resolveDurablePermissionInteractionByRequestId(input: {
  claim: PermissionCallbackClaimReference;
  reason?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  let applicationStarted = false;
  let authorityApplied = false;
  try {
    const pendingInteractions = (
      await active.repository.findPendingPermissionInteractions({
        scope: input.claim.scope,
      })
    ).filter(
      (interaction) =>
        permissionCallbackClaimFromPayload(interaction.payload)?.id ===
        input.claim.id,
    );
    if (pendingInteractions.length === 0) return false;
    const persistedClaim = permissionCallbackClaimFromPayload(
      pendingInteractions[0]!.payload,
    );
    if (!persistedClaim || !samePermissionClaim(persistedClaim, input.claim))
      return false;
    const envelope = sharedPermissionRecoveryEnvelope(pendingInteractions);
    if (!envelope) return false;
    if (
      persistedClaim.match.kind === 'individual' &&
      pendingInteractions.length !== 1
    ) {
      await releasePermissionInteractionCallback({ claim: input.claim });
      return false;
    }
    const reviewEachDecisions =
      persistedClaim.match.kind === 'batch' &&
      persistedClaim.intent.mode === 'allow_persistent_rule'
        ? await replayPersistedReviewEach({
            claim: persistedClaim,
            envelope,
            interactions: pendingInteractions,
            claimIsActive: true,
          })
        : null;
    if (
      reviewEachDecisions &&
      reviewEachDecisions.size !== pendingInteractions.length
    ) {
      return false;
    }

    for (const pending of pendingInteractions) {
      const sourceAgentFolder = sourceAgentFolderFromPermissionPayload(
        pending.payload,
      );
      if (sourceAgentFolder !== input.claim.scope.sourceAgentFolder) {
        await releasePermissionInteractionCallback({ claim: input.claim });
        return false;
      }
      const requestId =
        typeof pending.payload.requestId === 'string'
          ? pending.payload.requestId
          : null;
      if (!requestId) {
        await releasePermissionInteractionCallback({ claim: input.claim });
        return false;
      }
    }

    for (const pending of pendingInteractions) {
      const sourceAgentFolder = sourceAgentFolderFromPermissionPayload(
        pending.payload,
      )!;
      const requestId = pending.payload.requestId as string;
      const request = envelope.members.find(
        (member) => member.callback.requestId === requestId,
      )?.request;
      if (!request) return false;
      const decision =
        reviewEachDecisions?.get(requestId) ??
        recoveredPermissionDecision({
          request,
          claim: persistedClaim,
          reason: input.reason,
        });
      const decisionClaim =
        decision.permissionCallbackClaim ??
        (reviewEachDecisions ? null : input.claim);
      if (!decisionClaim) return false;
      try {
        applicationStarted = true;
        const applied = await active.applyDecision({
          request,
          sourceAgentFolder,
          decision,
          appId: input.claim.scope.appId,
          runId: pending.runId,
          runLeaseToken:
            typeof pending.payload.runLeaseToken === 'string'
              ? pending.payload.runLeaseToken
              : null,
          runLeaseFencingVersion:
            typeof pending.payload.runLeaseFencingVersion === 'number'
              ? pending.payload.runLeaseFencingVersion
              : null,
          toolName:
            typeof pending.payload.toolName === 'string'
              ? pending.payload.toolName
              : 'unknown',
          requestId,
        });
        if (!applied) {
          if (!authorityApplied) {
            await releasePermissionInteractionCallback({
              claim: decisionClaim,
            });
          }
          return false;
        }
        authorityApplied = true;
        const resolution = {
          kind: 'permission',
          sourceAgentFolder,
          requestId,
          appId: input.claim.scope.appId,
          runId: pending.runId,
          status: decision.mode === 'cancel' ? 'cancelled' : 'resolved',
          resolution: {
            approved: decision.approved,
            mode: decision.mode,
            reason: decision.reason ?? input.reason ?? null,
            updatedPermissions: decision.updatedPermissions ?? null,
            decisionClassification: decision.decisionClassification ?? null,
          },
          approverRef: decision.decidedBy ?? persistedClaim.intent.approverRef,
          permissionCallbackClaim: decisionClaim,
        } as const;
        const settled =
          (await active.resolve(resolution)) ||
          (await active.resolve(resolution));
        if (!settled) return false;
      } catch (err) {
        active.warn?.(
          { err, claim: input.claim, requestId },
          'Failed to settle durable permission interaction',
        );
        return false;
      }
    }
    return true;
  } catch (err) {
    active.warn?.(
      { err, claim: input.claim },
      'Failed to resolve durable permission interaction',
    );
    if (!applicationStarted) {
      await releasePermissionInteractionCallback({ claim: input.claim });
    }
    return false;
  }
}

function recoveredPermissionDecision(input: {
  request: PermissionApprovalRequest;
  claim: PermissionCallbackClaim;
  reason?: string | null;
}): PermissionApprovalDecision {
  const decision = decisionForMode(
    input.request,
    input.claim.intent.mode,
    input.claim.intent.approverRef,
  );
  return {
    ...decision,
    permissionCallbackClaim: permissionClaimReference(input.claim),
  };
}

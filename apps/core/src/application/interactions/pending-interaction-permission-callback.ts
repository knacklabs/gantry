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
    let member = pending.find(
      (interaction) =>
        interaction.kind === 'permission' &&
        interaction.status === 'pending' &&
        interaction.payload.requestId === input.requestId &&
        sourceAgentFolderFromPermissionPayload(interaction.payload) ===
          input.sourceAgentFolder,
    );
    if (!member) return null;
    let persistedClaim = permissionCallbackClaimFromPayload(member.payload);
    let settledClaim = permissionCallbackClaimFromValue(
      member.payload.permissionCallbackSettlement,
    );
    const reviewEachClaim =
      persistedClaim?.match.kind === 'batch' &&
      persistedClaim.intent.mode === 'allow_persistent_rule'
        ? persistedClaim
        : !persistedClaim &&
            settledClaim?.match.kind === 'batch' &&
            settledClaim.intent.mode === 'allow_persistent_rule'
          ? settledClaim
          : null;
    if (reviewEachClaim) {
      const expiration = await expireReviewEachClaim(active, reviewEachClaim);
      member = expiration.interactions.find(
        (interaction) => interaction.payload.requestId === input.requestId,
      );
      if (!member) return null;
      persistedClaim = permissionCallbackClaimFromPayload(member.payload);
      settledClaim = null;
    }
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

let backend: PermissionCallbackBackend | null = null;

export function configurePendingInteractionPermissionCallbacks(
  next: PermissionCallbackBackend | null,
): void {
  backend = next;
}

async function expireReviewEachClaim(
  active: PermissionCallbackBackend,
  claim: PermissionCallbackClaim,
): Promise<{ interactions: PendingInteraction[]; expired: boolean }> {
  let interactions = await active.repository.expirePendingPermissionReviewEach({
    claim: permissionClaimReference(claim),
    now: new Date().toISOString(),
  });
  const expired = interactions.length > 0;
  if (!expired) {
    interactions = await active.repository.findPendingPermissionInteractions({
      scope: claim.scope,
    });
    if (interactions.length === 0) {
      return { interactions, expired: false };
    }
  }
  const claims = interactions.map((interaction) =>
    permissionCallbackClaimFromPayload(interaction.payload),
  );
  if (
    claims.some((candidate) => {
      if (
        !candidate ||
        candidate.intent.mode !== 'cancel' ||
        candidate.intent.approverRef !== 'system'
      ) {
        return true;
      }
      return candidate.match.kind === 'batch'
        ? candidate.id !== claim.id ||
            !samePersistedPermissionClaim(candidate, claims[0]!)
        : !candidate.id.startsWith(`${claim.id}:expired:`);
    })
  ) {
    throw new Error('Expired review-each claim is malformed');
  }
  return { interactions, expired };
}

function expiredReviewEachMemberClaims(
  interactions: PendingInteraction[],
  scope: PermissionCallbackScope,
): PermissionCallbackClaim[] | null {
  const envelope = sharedPermissionRecoveryEnvelope(interactions);
  if (
    envelope?.batch?.canonicalId !== scope.interactionId ||
    envelope.members.length !== interactions.length ||
    envelope.members.some(
      (member) =>
        member.callback.appId !== scope.appId ||
        member.callback.sourceAgentFolder !== scope.sourceAgentFolder,
    )
  ) {
    return null;
  }
  const claims = interactions.map((interaction) =>
    permissionCallbackClaimFromPayload(interaction.payload),
  );
  const firstRequestId = interactions[0]?.payload.requestId;
  const firstClaim = claims[0];
  if (!firstClaim || typeof firstRequestId !== 'string') return null;
  const firstSuffix = `:expired:${firstRequestId}`;
  if (!firstClaim.id.endsWith(firstSuffix)) return null;
  const ownerClaimId = firstClaim.id.slice(0, -firstSuffix.length);
  if (!ownerClaimId) return null;
  const decidedAt = firstClaim.intent.decidedAt;
  if (
    interactions.some((interaction, index) => {
      const requestId = interaction.payload.requestId;
      const claim = claims[index];
      return (
        typeof requestId !== 'string' ||
        !claim ||
        claim.id !== `${ownerClaimId}:expired:${requestId}` ||
        claim.scope.appId !== scope.appId ||
        claim.scope.sourceAgentFolder !== scope.sourceAgentFolder ||
        claim.scope.interactionId !== requestId ||
        claim.intent.mode !== 'cancel' ||
        claim.intent.approverRef !== 'system' ||
        claim.intent.decidedAt !== decidedAt ||
        claim.match.kind !== 'individual' ||
        claim.match.canonicalId !== requestId
      );
    })
  ) {
    return null;
  }
  return claims as PermissionCallbackClaim[];
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
    const activeClaim = claims.find((value) => value !== null) ?? null;
    const expiredReviewEachClaims = expiredReviewEachMemberClaims(
      pending,
      input.scope,
    );
    if (
      activeClaim &&
      !expiredReviewEachClaims &&
      claims.some(
        (value) => !value || !samePersistedPermissionClaim(value, activeClaim),
      )
    ) {
      return null;
    }
    let claim = expiredReviewEachClaims ? null : activeClaim;
    if (!claim) {
      const settlements = pending.map((interaction) =>
        permissionCallbackClaimFromValue(
          interaction.payload.permissionCallbackSettlement,
        ),
      );
      const recoveredReviewEach =
        settlements.find(
          (value) =>
            value?.match.kind === 'batch' &&
            value.intent.mode === 'allow_persistent_rule',
        ) ?? null;
      if (
        recoveredReviewEach &&
        settlements.every(
          (value) =>
            value && samePersistedPermissionClaim(value, recoveredReviewEach),
        )
      ) {
        claim = recoveredReviewEach;
      }
    }
    const providerAliases = [
      ...new Set([
        ...(claim?.match.providerAliases ?? []),
        ...claims.flatMap((value) => value?.match.providerAliases ?? []),
        ...pending.flatMap((interaction) =>
          typeof interaction.payload.permissionCallbackId === 'string'
            ? [interaction.payload.permissionCallbackId]
            : [],
        ),
      ]),
    ];
    if (input.providerAlias && !providerAliases.includes(input.providerAlias)) {
      return null;
    }
    return {
      scope: input.scope,
      requestId: input.scope.interactionId,
      batchCallbackId:
        envelope.batch?.canonicalId === input.scope.interactionId ||
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
      persistedClaim?: PermissionCallbackClaim;
    }
  | { status: 'already_decided'; ownerless?: true }
  | { status: 'retryable' };

export async function claimPermissionInteractionCallback(input: {
  scope: PermissionCallbackScope;
  mode: PermissionCallbackClaim['intent']['mode'];
  approverRef: string;
  matchKind: PermissionCallbackClaim['match']['kind'];
  providerAlias?: string;
  expireReviewEach?: boolean;
  recoveredClaim?: PermissionCallbackClaim;
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
  const claim: PermissionCallbackClaim =
    input.recoveredClaim ??
    ({
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
    } satisfies PermissionCallbackClaim);
  if (
    claim.scope.appId !== input.scope.appId ||
    claim.scope.sourceAgentFolder !== input.scope.sourceAgentFolder ||
    claim.scope.interactionId !== input.scope.interactionId ||
    claim.match.canonicalId !== input.scope.interactionId ||
    claim.match.kind !== input.matchKind
  ) {
    return { status: 'retryable' };
  }
  try {
    if (input.recoveredClaim) {
      if (
        input.expireReviewEach &&
        claim.match.kind === 'batch' &&
        claim.intent.mode === 'allow_persistent_rule'
      ) {
        const expiration = await expireReviewEachClaim(active, claim);
        if (!expiration.expired) return { status: 'already_decided' };
        return {
          status: 'claimed',
          claim: permissionClaimReference(claim),
          persistedClaim: permissionCallbackClaimFromPayload(
            expiration.interactions[0]!.payload,
          )!,
        };
      }
      return {
        status: 'claimed',
        claim: permissionClaimReference(claim),
        persistedClaim: claim,
      };
    }
    const claimed = await active.repository.claimPendingPermissionCallback({
      claim,
    });
    if (claimed.length > 0) {
      if (
        input.expireReviewEach &&
        claim.match.kind === 'batch' &&
        claim.intent.mode === 'allow_persistent_rule'
      ) {
        const expiration = await expireReviewEachClaim(active, claim);
        if (!expiration.expired) return { status: 'already_decided' };
        return {
          status: 'claimed',
          claim: permissionClaimReference(claim),
          persistedClaim: permissionCallbackClaimFromPayload(
            expiration.interactions[0]!.payload,
          )!,
        };
      }
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
    if (hasHolder || expiredReviewEachMemberClaims(current, input.scope)) {
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
    let pendingInteractions =
      await active.repository.findPendingPermissionInteractions({
        scope: input.claim.scope,
      });
    if (pendingInteractions.length === 0) return false;
    let persistedClaims = pendingInteractions.map((interaction) =>
      permissionCallbackClaimFromPayload(interaction.payload),
    );
    const persistedClaim = persistedClaims.find(
      (claim) => claim && samePermissionClaim(claim, input.claim),
    );
    if (
      persistedClaim?.match.kind === 'batch' &&
      persistedClaim.intent.mode === 'allow_persistent_rule'
    ) {
      const expiration = await expireReviewEachClaim(active, persistedClaim);
      pendingInteractions = expiration.interactions;
      if (pendingInteractions.length === 0) return false;
      persistedClaims = pendingInteractions.map((interaction) =>
        permissionCallbackClaimFromPayload(interaction.payload),
      );
    }
    const envelope = sharedPermissionRecoveryEnvelope(pendingInteractions);
    if (!envelope) return false;
    const hasOriginalClaim = persistedClaims.every(
      (claim) => claim && samePermissionClaim(claim, input.claim),
    );
    const hasExpiredBatchMemberClaims =
      envelope.batch?.canonicalId === input.claim.scope.interactionId &&
      pendingInteractions.every((interaction, index) => {
        const claim = persistedClaims[index];
        const requestId = interaction.payload.requestId;
        return (
          typeof requestId === 'string' &&
          claim?.scope.appId === input.claim.scope.appId &&
          claim.scope.sourceAgentFolder ===
            input.claim.scope.sourceAgentFolder &&
          claim.scope.interactionId === requestId &&
          claim.intent.mode === 'cancel' &&
          claim.intent.approverRef === 'system' &&
          claim.match.kind === 'individual' &&
          claim.match.canonicalId === requestId &&
          claim.id.startsWith(`${input.claim.id}:expired:`)
        );
      });
    if (!hasOriginalClaim && !hasExpiredBatchMemberClaims) return false;
    if (
      persistedClaims[0]?.match.kind === 'individual' &&
      !hasExpiredBatchMemberClaims &&
      pendingInteractions.length !== 1
    ) {
      await releasePermissionInteractionCallback({ claim: input.claim });
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

    for (const [index, pending] of pendingInteractions.entries()) {
      const sourceAgentFolder = sourceAgentFolderFromPermissionPayload(
        pending.payload,
      )!;
      const requestId = pending.payload.requestId as string;
      const rowClaim = persistedClaims[index]!;
      const request = envelope.members.find(
        (member) => member.callback.requestId === requestId,
      )?.request;
      if (!request) return false;
      const decision = recoveredPermissionDecision({
        request,
        claim: rowClaim,
        reason: input.reason,
      });
      const decisionClaim = decision.permissionCallbackClaim!;
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
          approverRef: decision.decidedBy ?? rowClaim.intent.approverRef,
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

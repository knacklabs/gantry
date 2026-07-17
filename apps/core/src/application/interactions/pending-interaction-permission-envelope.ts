import type { PendingInteraction } from '../../domain/ports/worker-coordination.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackScope,
  PermissionRecoveryEnvelope,
} from '../../domain/types.js';

export interface DurablePermissionFullView {
  label: string;
  title: string;
  filename: string;
  content: string;
}

export function durablePermissionRequestSnapshot(
  request: PermissionApprovalRequest,
): PermissionApprovalRequest {
  return {
    requestId: request.requestId,
    appId: request.appId,
    agentId: request.agentId,
    providerAccountId: request.providerAccountId,
    sourceAgentFolder: request.sourceAgentFolder,
    runHandle: request.runHandle,
    jobId: request.jobId,
    runId: request.runId,
    targetJid: request.targetJid,
    approvalContextJid: request.approvalContextJid,
    threadId: request.threadId,
    toolName: request.toolName,
    toolInputSanitized: request.toolInputSanitized,
    toolInputSanitizedPaths: request.toolInputSanitizedPaths,
    suggestions: request.suggestions,
    decisionOptions: request.decisionOptions,
    decisionPolicy: request.decisionPolicy,
    semanticCapabilityDefinitions: request.semanticCapabilityDefinitions,
    permissionBatch: request.permissionBatch,
  };
}

export function readDurablePermissionFullView(
  value: unknown,
): DurablePermissionFullView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const label = durablePermissionFullViewString(candidate.label);
  const title = durablePermissionFullViewString(candidate.title);
  const filename = durablePermissionFullViewString(candidate.filename);
  const content = durablePermissionFullViewString(candidate.content);
  if (!label || !title || !filename || !content) return undefined;
  return { label, title, filename, content };
}

export function readPermissionRecoveryEnvelope(
  value: unknown,
): PermissionRecoveryEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Partial<PermissionRecoveryEnvelope>;
  if (
    envelope.version !== 1 ||
    !Array.isArray(envelope.renderedDecisionOptions) ||
    envelope.renderedDecisionOptions.length === 0 ||
    !envelope.renderedDecisionOptions.every(isPermissionDecisionMode) ||
    !isStringOrNull(envelope.targetJid) ||
    !isStringOrNull(envelope.approvalContextJid) ||
    !isStringOrNull(envelope.threadId) ||
    ![null, 'control_allowlist', 'same_channel'].includes(
      envelope.decisionPolicy ?? null,
    ) ||
    !isPermissionRequest(envelope.renderedRequest) ||
    !Array.isArray(envelope.members) ||
    envelope.members.length === 0
  ) {
    return null;
  }
  for (let index = 0; index < envelope.members.length; index += 1) {
    const member = envelope.members[index];
    if (
      !member ||
      !member.callback ||
      typeof member.callback.appId !== 'string' ||
      typeof member.callback.sourceAgentFolder !== 'string' ||
      typeof member.callback.requestId !== 'string' ||
      member.callback.index !== index ||
      !isPermissionRequest(member.request) ||
      member.request.requestId !== member.callback.requestId ||
      member.request.sourceAgentFolder !== member.callback.sourceAgentFolder
    ) {
      return null;
    }
  }
  if (
    envelope.batch !== null &&
    (!envelope.batch ||
      typeof envelope.batch.canonicalId !== 'string' ||
      !['decision', 'review_each'].includes(envelope.batch.phase) ||
      envelope.batch.canonicalId !== envelope.renderedRequest.requestId ||
      envelope.members.length < 2)
  ) {
    return null;
  }
  return envelope as PermissionRecoveryEnvelope;
}

export function sharedPermissionRecoveryEnvelope(
  interactions: PendingInteraction[],
): PermissionRecoveryEnvelope | null {
  const envelopes = interactions.map((interaction) =>
    readPermissionRecoveryEnvelope(
      interaction.payload.permissionRecoveryEnvelope,
    ),
  );
  const first = envelopes[0];
  if (
    !first ||
    envelopes.some((value) => JSON.stringify(value) !== JSON.stringify(first))
  ) {
    return null;
  }
  const rowRequestIds = new Set(
    interactions.map((interaction) => interaction.payload.requestId),
  );
  const memberRequestIds = new Set(
    first.members.map((member) => member.callback.requestId),
  );
  if (
    rowRequestIds.size !== interactions.length ||
    [...rowRequestIds].some(
      (requestId) => !memberRequestIds.has(String(requestId)),
    )
  ) {
    return null;
  }
  return first;
}

export function permissionRequestFromPayload(
  payload: Record<string, unknown>,
): PermissionApprovalRequest | null {
  return isPermissionRequest(payload.request) ? payload.request : null;
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function readPermissionCallbackClaim(
  value: unknown,
): PermissionCallbackClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const claim = value as Partial<PermissionCallbackClaim>;
  const scope = claim.scope as Partial<PermissionCallbackScope> | undefined;
  const intent = claim.intent as Partial<PermissionCallbackClaim['intent']>;
  const match = claim.match as Partial<PermissionCallbackClaim['match']>;
  if (
    typeof claim.id !== 'string' ||
    typeof scope?.appId !== 'string' ||
    typeof scope.sourceAgentFolder !== 'string' ||
    typeof scope.interactionId !== 'string' ||
    !['allow_once', 'allow_persistent_rule', 'cancel'].includes(
      String(intent?.mode),
    ) ||
    typeof intent?.approverRef !== 'string' ||
    typeof intent.decidedAt !== 'string' ||
    (match?.kind !== 'individual' && match?.kind !== 'batch') ||
    typeof match.canonicalId !== 'string' ||
    !Array.isArray(match.providerAliases) ||
    !match.providerAliases.every((alias) => typeof alias === 'string')
  ) {
    return null;
  }
  return claim as PermissionCallbackClaim;
}

export function samePermissionCallbackClaim(
  left: PermissionCallbackClaim,
  right: PermissionCallbackClaim,
): boolean {
  return (
    left.id === right.id &&
    left.scope.appId === right.scope.appId &&
    left.scope.sourceAgentFolder === right.scope.sourceAgentFolder &&
    left.scope.interactionId === right.scope.interactionId &&
    left.intent.mode === right.intent.mode &&
    left.intent.approverRef === right.intent.approverRef &&
    left.intent.decidedAt === right.intent.decidedAt &&
    left.match.kind === right.match.kind &&
    left.match.canonicalId === right.match.canonicalId
  );
}

function durablePermissionFullViewString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isPermissionDecisionMode(
  value: unknown,
): value is PermissionApprovalDecisionMode {
  return ['allow_once', 'allow_persistent_rule', 'cancel'].includes(
    String(value),
  );
}

function isPermissionRequest(
  value: unknown,
): value is PermissionApprovalRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Partial<PermissionApprovalRequest>;
  return (
    typeof request.requestId === 'string' &&
    typeof request.sourceAgentFolder === 'string' &&
    typeof request.toolName === 'string'
  );
}

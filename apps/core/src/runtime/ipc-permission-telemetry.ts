import { createHash } from 'node:crypto';

import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { redactSensitiveText } from '../shared/sensitive-material.js';

export function permissionDecisionName(
  decision: PermissionApprovalDecision,
): 'allowed' | 'cancelled' | 'denied' {
  if (decision.approved) return 'allowed';
  return decision.mode === 'cancel' ? 'cancelled' : 'denied';
}

export function permissionDecisionEventType(
  decision: PermissionApprovalDecision,
) {
  if (decision.approved) return RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED;
  return decision.mode === 'cancel'
    ? RUNTIME_EVENT_TYPES.PERMISSION_CANCELLED
    : RUNTIME_EVENT_TYPES.PERMISSION_DENIED;
}

export function permissionTelemetryContext(
  request: PermissionApprovalRequest,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const command = permissionCommand(request);
  return {
    appId: request.appId,
    agentId: request.agentId,
    runId: request.runId,
    runLeaseFencingVersion: request.runLeaseFencingVersion,
    jobId: request.jobId,
    conversationId: request.targetJid,
    threadId: request.threadId,
    requestId: request.requestId,
    toolName: request.toolName,
    decisionReason: request.decisionReason,
    canonicalCapability: permissionCanonicalCapability(request),
    ...safeCommandTelemetry(command),
    ...extra,
  };
}

function permissionCanonicalCapability(
  request: PermissionApprovalRequest,
): string {
  const capabilityId = request.interaction?.requestContext?.capabilityId;
  if (capabilityId) return capabilityId;
  const toolInputCapabilityId = request.toolInput?.capabilityId;
  if (typeof toolInputCapabilityId === 'string' && toolInputCapabilityId) {
    return toolInputCapabilityId;
  }
  return request.toolName;
}

function permissionCommand(request: PermissionApprovalRequest): string | null {
  if (request.toolName !== 'Bash' && request.toolName !== 'RunCommand') {
    return null;
  }
  const command = request.toolInput?.command ?? request.toolInput?.cmd;
  return typeof command === 'string' && command.trim() ? command.trim() : null;
}

function safeCommandTelemetry(command: string | null): Record<string, unknown> {
  if (!command) return {};
  return {
    commandPreview: redactSensitiveText(command).slice(0, 160),
    commandHash: createHash('sha256').update(command).digest('hex'),
  };
}

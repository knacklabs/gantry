import { normalizePermissionAction } from './permission-interaction.js';
import type { TeamsPermissionCallback } from './teams-types.js';

export function readTeamsPermissionDecision(value: unknown): {
  callback: TeamsPermissionCallback;
  decision: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as {
    action?: unknown;
    callback?: unknown;
    decision?: unknown;
    data?: unknown;
  };
  const candidate =
    payload.action === 'permission_decision'
      ? payload
      : payload.data && typeof payload.data === 'object'
        ? (payload.data as typeof payload)
        : null;
  if (!candidate || candidate.action !== 'permission_decision') return null;
  const callback = readTeamsPermissionCallback(candidate.callback);
  if (!callback) return null;
  if (
    typeof candidate.decision !== 'string' ||
    !normalizePermissionAction(candidate.decision)
  ) {
    return null;
  }
  return {
    callback,
    decision: candidate.decision,
  };
}

function readTeamsPermissionCallback(
  value: unknown,
): TeamsPermissionCallback | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scope = candidate.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  const parsedScope = scope as Record<string, unknown>;
  if (
    typeof candidate.providerAlias !== 'string' ||
    !candidate.providerAlias ||
    (candidate.matchKind !== 'individual' && candidate.matchKind !== 'batch') ||
    typeof parsedScope.appId !== 'string' ||
    !parsedScope.appId ||
    typeof parsedScope.sourceAgentFolder !== 'string' ||
    !parsedScope.sourceAgentFolder ||
    typeof parsedScope.interactionId !== 'string' ||
    !parsedScope.interactionId
  ) {
    return null;
  }
  return {
    providerAlias: candidate.providerAlias,
    scope: {
      appId: parsedScope.appId,
      sourceAgentFolder: parsedScope.sourceAgentFolder,
      interactionId: parsedScope.interactionId,
    },
    matchKind: candidate.matchKind,
  };
}

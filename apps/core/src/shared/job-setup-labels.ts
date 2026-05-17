import { getBuiltinSemanticCapability } from './semantic-capabilities.js';

export interface JobSetupLabelBlocker {
  state?: string;
  requirementType?: string;
  requirementId?: string;
  nextAction?: string;
}

export function jobSetupBlockerFromUnknown(
  value: unknown,
): JobSetupLabelBlocker | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return {
    state: stringField(record.state),
    requirementType: stringField(record.requirementType),
    requirementId: stringField(record.requirementId),
    nextAction: stringField(record.nextAction),
  };
}

export function setupBlockerLabel(
  blocker: JobSetupLabelBlocker | undefined,
  fallbackState: string,
): string {
  if (!blocker) return humanizeIdentifier(fallbackState);
  if (
    blocker.requirementType === 'local_cli' &&
    blocker.state === 'missing_capability'
  ) {
    return 'Job CLI configuration';
  }
  if (blocker.requirementType === 'local_cli') return 'Exact command access';
  if (blocker.requirementType === 'browser') {
    return blocker.state === 'browser_login_may_be_required'
      ? 'Browser login'
      : 'Browser access';
  }
  if (blocker.requirementType === 'semantic_capability') {
    return semanticCapabilityLabel(blocker.requirementId);
  }
  if (blocker.requirementType === 'mcp_server') {
    return `MCP server: ${humanizeIdentifier(blocker.requirementId)}`;
  }
  if (blocker.requirementType === 'credential') {
    return `Credential: ${semanticCapabilityLabel(blocker.requirementId)}`;
  }
  return `Tool access: ${humanizeIdentifier(blocker.requirementId)}`;
}

export function setupActionLabel(
  blocker: JobSetupLabelBlocker | undefined,
): string {
  if (!blocker) return 'Fix setup, then resume the job.';
  const nextAction = blocker.nextAction ?? '';
  if (
    blocker.requirementType === 'local_cli' &&
    blocker.state === 'missing_capability'
  ) {
    return 'Fix the job CLI configuration, then resume the job.';
  }
  if (
    blocker.requirementType === 'local_cli' ||
    /request_permission\s*\{[^}]*"toolName"\s*:\s*"Bash"/.test(nextAction)
  ) {
    return 'Approve exact command access, then resume the job.';
  }
  if (blocker.requirementType === 'browser') {
    if (blocker.state === 'browser_login_may_be_required' && nextAction) {
      return nextAction;
    }
    return 'Approve Browser access, then resume the job.';
  }
  if (blocker.requirementType === 'semantic_capability') {
    return `Approve ${semanticCapabilityLabel(blocker.requirementId)}, then resume the job.`;
  }
  if (blocker.requirementType === 'mcp_server') {
    return `Approve ${humanizeIdentifier(blocker.requirementId)} MCP server access, then resume the job.`;
  }
  if (blocker.requirementType === 'credential' && nextAction) return nextAction;
  return setupActionLabelFromNextAction(nextAction);
}

export function setupActionLabelFromNextAction(
  nextAction: unknown,
  fallback = 'Fix setup, then resume the job.',
): string {
  if (typeof nextAction !== 'string' || !nextAction.trim()) return fallback;
  if (/scheduler_update_job\s*\{/.test(nextAction)) {
    return 'Update the job setup, then resume the job.';
  }
  if (/request_permission\s*\{[^}]*"toolName"\s*:\s*"Bash"/.test(nextAction)) {
    return 'Approve exact command access, then resume the job.';
  }
  if (
    /request_permission\s*\{[^}]*"toolName"\s*:\s*"Browser"/.test(nextAction)
  ) {
    return 'Approve Browser access, then resume the job.';
  }
  if (/request_permission\s*\{/.test(nextAction)) {
    return 'Approve the requested access, then resume the job.';
  }
  return nextAction;
}

function semanticCapabilityLabel(capabilityId: string | undefined): string {
  return capabilityId
    ? (getBuiltinSemanticCapability(capabilityId)?.displayName ??
        humanizeIdentifier(capabilityId))
    : 'Required capability';
}

function humanizeIdentifier(value: string | undefined): string {
  return (value ?? 'setup')
    .replace(/^capability:/, '')
    .replace(/^mcp:/, '')
    .replaceAll(/[._:-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

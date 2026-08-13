import type { JobSetupActionShape } from './job-setup-action.js';

export interface JobSetupLabelBlocker {
  state: string;
  type: string;
  id: string;
  action: JobSetupActionShape;
}

export function jobSetupBlockerFromUnknown(
  value: unknown,
): JobSetupLabelBlocker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const blocker = value as Partial<JobSetupLabelBlocker>;
  if (
    typeof blocker.state !== 'string' ||
    typeof blocker.type !== 'string' ||
    typeof blocker.id !== 'string' ||
    !blocker.action
  ) {
    return undefined;
  }
  return blocker as JobSetupLabelBlocker;
}

export function setupBlockerLabel(
  blocker: Pick<JobSetupLabelBlocker, 'state' | 'type' | 'id'> | undefined,
  fallbackState: string,
): string {
  if (!blocker) return humanizeIdentifier(fallbackState);
  if (blocker.type === 'local_cli') {
    return semanticCapabilityLabel(blocker.id);
  }
  if (blocker.type === 'browser') {
    return blocker.state === 'browser_login_may_be_required'
      ? 'Browser login'
      : 'Browser access';
  }
  if (blocker.type === 'semantic_capability') {
    return semanticCapabilityLabel(blocker.id);
  }
  if (blocker.type === 'mcp_server') {
    return `MCP server: ${humanizeIdentifier(blocker.id)}`;
  }
  if (blocker.type === 'credential') {
    return `Credential: ${semanticCapabilityLabel(blocker.id)}`;
  }
  return `Tool access: ${humanizeIdentifier(blocker.id)}`;
}

export function formatJobSetupAction(
  action: JobSetupActionShape | undefined,
  blocker?: Pick<JobSetupLabelBlocker, 'state' | 'type' | 'id'>,
): string {
  if (!action) return 'Fix setup, then resume the job.';
  if (action.kind === 'instruction') return action.text;
  if (action.kind === 'fix_proposal') {
    return 'Review the proposed setup fix, then resume the job.';
  }
  if (
    action.grant.rules.some(
      (rule) => rule.toolName === 'RunCommand' && rule.ruleContent,
    )
  ) {
    return 'Approve exact command access, then resume the job.';
  }
  const label = setupBlockerLabel(blocker, 'required capability');
  return `Approve ${label}, then resume the job.`;
}

/** Public 4-state job readiness label. */
export function setupReadinessLabel(state: string | undefined): string {
  if (state === 'ready' || !state) return 'Ready';
  if (state === 'missing_capability') return 'Needs approval';
  if (
    state === 'credential_unknown' ||
    state === 'mcp_missing_credential' ||
    state === 'browser_login_may_be_required'
  ) {
    return 'Needs connection';
  }
  return 'Blocked';
}

function semanticCapabilityLabel(capabilityId: string | undefined): string {
  return capabilityId
    ? humanizeIdentifier(capabilityId)
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

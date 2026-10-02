import type { PermissionCardAffordances } from '../../domain/permission-card-affordances.js';
import type {
  PermissionApprovalRequest,
  PermissionRememberCode,
} from '../../domain/types.js';
import { adminMcpToolNameFromFullName } from '../../shared/admin-mcp-tools.js';
import {
  isCanonicalBrowserCapabilityRule,
  isThirdPartyMcpToolRule,
  publicGantryToolNameForSdkTool,
} from '../../shared/agent-tool-references.js';
import { USER_FACING_TOOL_LABELS } from '../../shared/permission-tool-labels.js';
import { sanitizeOutboundLlmText } from '../../shared/sensitive-material.js';
import {
  GantryToolRiskVerdict,
  gantryNativeCanonicalToolName,
  gantryToolRisk,
} from './gantry-tool-risk.js';
import type { PermissionRememberContext } from './human-decision-learning.js';

export interface BuildPermissionCardAffordancesInput {
  request: PermissionApprovalRequest;
  rememberContext: Pick<PermissionRememberContext, 'eligible' | 'candidates'>;
}

/** Card copy for the one save target a card offers: "Allow for future"
 *  remembers this exact action. Deny is never remembered. */
export function buildPermissionCardAffordances(
  input: BuildPermissionCardAffordancesInput,
): PermissionCardAffordances {
  if (!input.rememberContext.eligible) return scalarPermissionCardAffordances();
  const exact = input.rememberContext.candidates.exact;
  if (!exact.ok && exact.reason === 'protected_destination') {
    const path = protectedPath(input.request) ?? 'This path';
    return {
      eligible: true,
      offered: [],
      destructive: false,
      protected: true,
      preTapLines: [`${path} is protected, so I always ask.`],
      postTapLines: {},
    };
  }
  if (!exact.ok) return scalarPermissionCardAffordances();
  const destructive = input.request.risk_category === 'destructive';
  const writePath = permissionWritePath(input.request);
  const scope = destructive
    ? 'this exact command only — nothing broader'
    : writePath
      ? `writing to ${writePath} — any future content, no more asking for this file`
      : 'this exact action';
  return {
    eligible: true,
    offered: ['remember_allow_exact'],
    destructive,
    protected: false,
    preTapLines: [`Allow for future remembers: ${scope}.`],
    postTapLines: {
      remember_allow_exact: writePath
        ? `Remembered: writes to ${writePath} (any content). Change it any time with /permissions.`
        : 'Remembered: this exact action. Change it any time with /permissions.',
    },
  };
}

export function scalarPermissionCardAffordances(): PermissionCardAffordances {
  return {
    eligible: false,
    offered: [],
    destructive: false,
    protected: false,
    preTapLines: [],
    postTapLines: {},
  };
}

export function parsePermissionCardAffordances(
  value: unknown,
): PermissionCardAffordances | null {
  if (!isRecord(value)) return null;
  const offered = Array.isArray(value.offered)
    ? value.offered.filter(isPermissionRememberCodeValue)
    : [];
  if (
    typeof value.eligible !== 'boolean' ||
    !Array.isArray(value.offered) ||
    offered.length !== value.offered.length ||
    typeof value.destructive !== 'boolean' ||
    typeof value.protected !== 'boolean' ||
    !isStringArray(value.preTapLines) ||
    !isPostTapLines(value.postTapLines)
  ) {
    return null;
  }
  return {
    eligible: value.eligible,
    offered,
    destructive: value.destructive,
    protected: value.protected,
    preTapLines: [...value.preTapLines],
    postTapLines: { ...value.postTapLines },
  };
}

export function permissionHumanToolLabel(
  toolName: string | undefined,
): string | undefined {
  const publicName = publicGantryToolNameForSdkTool(toolName?.trim() ?? '');
  if (!publicName) return undefined;
  const label = USER_FACING_TOOL_LABELS[publicName];
  if (label) return label;
  if (
    isCanonicalBrowserCapabilityRule(publicName) ||
    publicName.startsWith('mcp__gantry__browser_')
  ) {
    return 'Browser';
  }
  const adminName = adminMcpToolNameFromFullName(publicName);
  if (adminName) return `Gantry ${humanizeIdentifier(adminName)}`;
  if (isThirdPartyMcpToolRule(publicName)) {
    return `${humanizeMcpServerName(publicName)} tool access`;
  }
  return undefined;
}

function humanizeMcpServerName(toolName: string): string {
  const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
  return match?.[1] ? humanizeIdentifier(match[1]) : 'third-party';
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/^mcp__/, '')
    .replaceAll(/[._-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function permissionWritePath(
  request: PermissionApprovalRequest,
): string | undefined {
  if (!isPermissionWrite(request)) return undefined;
  return permissionPath(request);
}

function isPermissionWrite(request: PermissionApprovalRequest): boolean {
  const publicToolName = publicGantryToolNameForSdkTool(request.toolName);
  if (publicToolName === 'FileWrite' || publicToolName === 'FileEdit') {
    return true;
  }
  const action = request.toolInput?.action;
  return (
    gantryNativeCanonicalToolName(request.toolName)?.canonical === 'file' &&
    (action === 'write' || action === 'promote_scratch') &&
    gantryToolRisk({
      toolName: request.toolName,
      toolInput: request.classifierToolInput ?? request.toolInput,
    }).verdict !== GantryToolRiskVerdict.Ambiguous
  );
}

function permissionPath(
  request: PermissionApprovalRequest,
): string | undefined {
  const input = request.toolInput;
  const path = input?.file_path ?? input?.path ?? input?.targetPath;
  return typeof path === 'string' && path.trim()
    ? sanitizePermissionCardText(path.trim(), 250, 100)
    : undefined;
}

function protectedPath(request: PermissionApprovalRequest): string | undefined {
  const path = request.blockedPath?.trim() || permissionPath(request);
  return path ? sanitizePermissionCardText(path, 250, 100) : undefined;
}

function sanitizePermissionCardText(
  input: string,
  head: number,
  tail: number,
): string {
  const result = sanitizeOutboundLlmText(input);
  if (result.blocked) return 'Sensitive detail hidden.';
  return result.text.length <= head + tail + 1
    ? result.text
    : `${result.text.slice(0, head)}…${result.text.slice(-tail)}`;
}

function isPermissionRememberCodeValue(
  value: unknown,
): value is PermissionRememberCode {
  return (
    value === 'remember_allow_exact' ||
    value === 'remember_allow_kind' ||
    value === 'remember_allow_place' ||
    value === 'remember_deny_exact'
  );
}

function isPostTapLines(
  value: unknown,
): value is PermissionCardAffordances['postTapLines'] {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([code, line]) =>
      isPermissionRememberCodeValue(code) && typeof line === 'string',
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((line) => typeof line === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

import { firstPersistentRule } from '../../domain/permission-decision.js';
import type { PermissionCardAffordances } from '../../domain/permission-card-affordances.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionRememberCode,
} from '../../domain/types.js';
import { adminMcpToolNameFromFullName } from '../../shared/admin-mcp-tools.js';
import {
  isCanonicalBrowserCapabilityRule,
  isThirdPartyMcpToolRule,
  parseReadableScopedToolRule,
  publicGantryToolNameForSdkTool,
} from '../../shared/agent-tool-references.js';
import { isFamilyRunCommandRule } from '../../shared/family-rule-synthesis.js';
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
  canonicalRoot?: string;
  highRisk: boolean;
  countExactAllowsByTool?: () => Promise<number>;
  warn?: (context: Record<string, unknown>, message: string) => void;
}

export async function buildPermissionCardAffordances(
  input: BuildPermissionCardAffordancesInput,
): Promise<PermissionCardAffordances> {
  if (!input.rememberContext.eligible) return scalarPermissionCardAffordances();

  const protectedCard =
    !input.rememberContext.candidates.exact.ok &&
    input.rememberContext.candidates.exact.reason === 'protected_destination';
  const destructive = input.request.risk_category === 'destructive';
  const writePath = permissionWritePath(input.request);
  const exactScope = writePath
    ? `writing to ${writePath} — any future content, no more asking for this file`
    : 'this exact action';
  const exactReceipt = writePath
    ? `Remembered: writes to ${writePath} (any content). Change it any time with /permissions.`
    : rememberedReceipt('this exact action');
  const denyReceipt =
    "I'll keep saying no to this exact action. Change it with /permissions.";

  if (protectedCard) {
    const path = protectedPath(input.request) ?? 'This path';
    return {
      eligible: true,
      offered: ['remember_deny_exact'],
      destructive: false,
      protected: true,
      preTapLines: [`${path} is protected, so I always ask.`],
      postTapLines: { remember_deny_exact: denyReceipt },
    };
  }

  const alternative = destructive
    ? undefined
    : await permissionCardAlternative(input);
  const offered: PermissionRememberCode[] = [
    'remember_allow_exact',
    ...(alternative && isPermissionRememberCode(alternative.code)
      ? [alternative.code]
      : []),
    'remember_deny_exact',
  ];
  const preTapLines = destructive
    ? [
        'Allow will remember: this exact command only — nothing broader. No will remember: this exact command.',
      ]
    : [
        `Allow will remember: ${exactScope}`,
        ...(alternative ? [alternative.line] : []),
        'No will remember: this exact action.',
      ];
  const postTapLines: PermissionCardAffordances['postTapLines'] = {
    remember_allow_exact: exactReceipt,
    remember_deny_exact: denyReceipt,
  };
  if (alternative?.code === 'remember_allow_kind') {
    postTapLines.remember_allow_kind = rememberedReceipt(
      'this kind of action, anywhere',
    );
  } else if (alternative?.code === 'remember_allow_place') {
    postTapLines.remember_allow_place = rememberedReceipt(
      `only in ${input.canonicalRoot!.trim()}`,
    );
  }
  return {
    eligible: true,
    offered,
    ...(alternative ? { alternative } : {}),
    destructive,
    protected: false,
    preTapLines,
    postTapLines,
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
  const alternative = parseAlternative(value.alternative);
  if (value.alternative !== undefined && !alternative) return null;
  return {
    eligible: value.eligible,
    offered,
    ...(alternative ? { alternative } : {}),
    destructive: value.destructive,
    protected: value.protected,
    preTapLines: [...value.preTapLines],
    postTapLines: { ...value.postTapLines },
  };
}

async function permissionCardAlternative(
  input: BuildPermissionCardAffordancesInput,
): Promise<PermissionCardAffordances['alternative']> {
  const family = familyAlternative(input.request);
  if (family) return family;

  // Owner ruling: the human label first, else the name the card shows, else
  // no trust-growth button — the canonical id never appears in card copy.
  const label =
    permissionHumanToolLabel(input.request.toolName) ??
    input.request.displayName?.trim();
  if (input.highRisk && label && input.countExactAllowsByTool) {
    try {
      if ((await input.countExactAllowsByTool()) >= 3) {
        return {
          code: 'remember_allow_kind',
          label: `Allow all ${label} actions`,
          line: `Allow all ${label} actions will remember: every ${label} action, anywhere.`,
        };
      }
    } catch {
      input.warn?.(
        {
          requestId: input.request.requestId,
          toolName: input.request.toolName,
        },
        'Permission card trust-growth count unavailable',
      );
    }
  }

  const root = input.canonicalRoot?.trim();
  if (
    root &&
    input.rememberContext.candidates.kind.ok &&
    input.rememberContext.candidates.place.ok
  ) {
    return {
      code: 'remember_allow_place',
      label: 'Allow only in this folder',
      line: `Allow only in this folder will remember: only in ${root}.`,
    };
  }
  return undefined;
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

function familyAlternative(
  request: PermissionApprovalRequest,
): PermissionCardAffordances['alternative'] {
  const rule = firstPersistentRule(request);
  if (!rule || !isFamilyRunCommandRule(rule)) return undefined;
  const scoped = parseReadableScopedToolRule(rule);
  if (!scoped?.scope.endsWith(' *')) return undefined;
  const family = sanitizePermissionCardText(
    scoped.scope.slice(0, -2).trim(),
    80,
    30,
  );
  if (!family) return undefined;
  return {
    code: 'allow_persistent_rule',
    label: `Allow all \`${family}\` commands`,
    line: `Allow for future covers: ${sanitizePermissionCardText(scoped.scope, 120, 40)}`,
  };
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

function rememberedReceipt(scope: string): string {
  return `Remembered: ${scope}. Change it any time with /permissions.`;
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

function isPermissionRememberCode(
  code: PermissionApprovalDecisionMode | PermissionRememberCode,
): code is PermissionRememberCode {
  return code.startsWith('remember_');
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

function parseAlternative(
  value: unknown,
): PermissionCardAffordances['alternative'] {
  if (!isRecord(value)) return undefined;
  const code = value.code;
  return isPermissionDecisionCode(code) &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    typeof value.line === 'string' &&
    value.line.length > 0
    ? { code, label: value.label, line: value.line }
    : undefined;
}

function isPermissionDecisionCode(
  value: unknown,
): value is PermissionApprovalDecisionMode | PermissionRememberCode {
  return (
    isPermissionRememberCodeValue(value) ||
    value === 'allow_once' ||
    value === 'allow_persistent_rule' ||
    value === 'cancel'
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

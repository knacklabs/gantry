import { createHash } from 'node:crypto';

import {
  isAdminMcpToolFullName,
  isGantryMcpWildcardRule,
} from './admin-mcp-tools.js';
import {
  nonDurableBashLeafReason,
  parseBashCommand,
  wildcardSensitiveBashLeafReason,
} from './bash-command-parser.js';
import {
  isCanonicalBrowserCapabilityRule,
  isGantryFacadeExactToolRule,
  parseReadableScopedToolRule,
  RUN_COMMAND_TOOL_NAME,
  validateReadableAgentToolRule,
} from './agent-tool-references.js';
import {
  getBuiltinSemanticCapability,
  type SemanticCapabilityDefinition,
} from './semantic-capabilities.js';
import { parseSemanticCapabilityRule } from './semantic-capability-ids.js';
import {
  classifySensitiveMemoryMaterial,
  detectPotentialUnredactedSecret,
  redactSensitiveText,
} from './sensitive-material.js';

export const PERSISTENT_REQUEST_PERMISSION_RULE_REJECTION_REASON =
  'Persistent request_permission approvals support only trusted projected semantic capabilities, canonical Browser, exact Gantry file/web tools, scoped RunCommand(...), or exact Gantry admin tools; use propose_capability for semantic app/tool access.';

export function validatePersistentRequestPermissionRule(
  rule: string,
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
    allowUnknownSemanticCapability?: boolean;
  } = {},
): { ok: true } | { ok: false; reason: string } {
  const trimmed = rule.trim();
  if (isGantryMcpWildcardRule(trimmed)) {
    return {
      ok: false,
      reason:
        'Persistent Gantry MCP wildcard grants are not supported; request one exact mcp__gantry__ tool.',
    };
  }

  const readableValidation = validateReadableAgentToolRule(trimmed);
  if (!readableValidation.ok) return readableValidation;
  if (isGantryFacadeExactToolRule(trimmed)) return { ok: true };

  const scoped = parseReadableScopedToolRule(trimmed);
  if (scoped) {
    if (scoped.toolName !== RUN_COMMAND_TOOL_NAME) {
      return {
        ok: false,
        reason:
          'Only RunCommand supports persistent scoped tool rules; use an exact tool name for other tools.',
      };
    }
    const parsed = parseBashCommand(scoped.scope);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `Persistent RunCommand rule cannot be parsed safely (${parsed.reason}); use Allow once.`,
      };
    }
    const destructiveRedirect = parsed.leaves
      .flatMap((leaf) => leaf.redirects)
      .find((redirect) => redirect.destructive);
    if (destructiveRedirect) {
      return {
        ok: false,
        reason:
          'Persistent RunCommand rules cannot include destructive redirection; use Allow once.',
      };
    }
    const nonDurableReason = parsed.leaves
      .map(nonDurableBashLeafReason)
      .find((reason): reason is string => Boolean(reason));
    if (nonDurableReason) return { ok: false, reason: nonDurableReason };
    const wildcardSensitiveReason = parsed.leaves
      .map((leaf) => wildcardSensitiveBashLeafReason(leaf, scoped.scope))
      .find((reason): reason is string => Boolean(reason));
    if (wildcardSensitiveReason) {
      return { ok: false, reason: wildcardSensitiveReason };
    }
    const secretReason = persistentBashSecretReason(scoped.scope);
    if (secretReason) {
      return {
        ok: false,
        reason: `Persistent RunCommand rules cannot include secret-like material (${secretReason}); use Allow once.`,
      };
    }
    return { ok: true };
  }

  const capabilityId = parseSemanticCapabilityRule(trimmed);
  if (capabilityId) {
    const definition =
      options.semanticCapabilityDefinitions?.[capabilityId] ??
      getBuiltinSemanticCapability(capabilityId);
    if (!definition) {
      if (options.allowUnknownSemanticCapability) return { ok: true };
      return {
        ok: false,
        reason: `Unknown semantic capability ${capabilityId}. Review and register a trusted capability definition before granting it persistently.`,
      };
    }
    return { ok: true };
  }

  if (isCanonicalBrowserCapabilityRule(trimmed)) return { ok: true };
  if (isAdminMcpToolFullName(trimmed)) return { ok: true };

  return {
    ok: false,
    reason: PERSISTENT_REQUEST_PERMISSION_RULE_REJECTION_REASON,
  };
}

export function isPersistentRequestPermissionRuleAllowed(
  rule: string,
  options?: Parameters<typeof validatePersistentRequestPermissionRule>[1],
): boolean {
  return validatePersistentRequestPermissionRule(rule, options).ok;
}

export function formatPersistentPermissionRulesForUser(
  rules: readonly string[],
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
  } = {},
): string {
  return rules
    .map((rule) => formatPersistentPermissionRuleForUser(rule, options))
    .join(', ');
}

export function formatPersistentPermissionRuleForEvent(rule: string): string {
  return formatPersistentPermissionRuleForUser(rule);
}

export function persistentPermissionRuleAuditPreview(rule: string): string {
  return formatPersistentPermissionRuleForUser(rule);
}

function formatPersistentPermissionRuleForUser(
  rule: string,
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
  } = {},
): string {
  const trimmed = rule.trim();
  const hash = shortRuleHash(trimmed);
  const scoped = parseReadableScopedToolRule(trimmed);
  if (scoped?.toolName === RUN_COMMAND_TOOL_NAME) {
    return `scoped RunCommand rule [sha256:${hash}]`;
  }
  const capabilityId = parseSemanticCapabilityRule(trimmed);
  if (capabilityId) {
    const definition =
      options.semanticCapabilityDefinitions?.[capabilityId] ??
      getBuiltinSemanticCapability(capabilityId);
    if (definition) return `${definition.displayName} [sha256:${hash}]`;
  }
  return `${truncate(redactSensitiveText(trimmed), 160)} [sha256:${hash}]`;
}

function persistentBashSecretReason(scope: string): string | null {
  const redacted = redactSensitiveText(scope);
  if (redacted !== scope) return 'redaction_required';
  return (
    classifySensitiveMemoryMaterial(scope) ??
    detectPotentialUnredactedSecret(scope)
  );
}

function shortRuleHash(rule: string): string {
  return createHash('sha256').update(rule).digest('hex').slice(0, 16);
}

function truncate(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : `${value.slice(0, maxLen - 1)}...`;
}

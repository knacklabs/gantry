import {
  isAdminMcpToolFullName,
  isGantryMcpWildcardRule,
  isDurableSchedulerMcpToolFullName,
} from './admin-mcp-tools.js';
import {
  type BashCommandLeaf,
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
  containsGeneratedRuntimePath,
  containsGeneratedRuntimeSkillPath,
  GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON,
} from './generated-runtime-paths.js';
import type { SemanticCapabilityDefinition } from './semantic-capabilities.js';
import { parseSemanticCapabilityRule } from './semantic-capability-ids.js';
import {
  classifySensitiveMemoryMaterial,
  detectPotentialUnredactedSecret,
  redactSensitiveText,
} from './sensitive-material.js';

/**
 * Single source of truth for "may this access rule be stored/granted durably".
 *
 * This is the durable-decision validator shared by request review, the
 * persistent permission write path, settings reconcile, job preflight, and job
 * access requirement validation. It is NOT the runtime allow/deny decision
 * interface — that remains `ToolExecutionPolicyService.evaluate()`.
 *
 * The accept-set is the reconciliation of the previous three divergent
 * validators (persistent request permission rules, job tool access
 * requirements, and settings reconcile shape check):
 *   - projected semantic capabilities `capability:<id>`
 *   - canonical Browser
 *   - exact Gantry facade file/web tools
 *   - exact Gantry admin MCP tools (the closed admin allowlist)
 *   - exact Gantry scheduler MCP tools
 *   - scoped `RunCommand(...)` with the bash-parser durable safety rejections
 * Gantry MCP wildcards and generated runtime skill paths are rejected.
 */

export const DURABLE_ACCESS_RULE_REJECTION_REASON =
  'Persistent access approvals support only trusted projected semantic capabilities, canonical Browser, exact Gantry file/web tools, scoped RunCommand(...), or exact Gantry admin/scheduler tools; use request_access with target.kind=capability for reviewed semantic app/tool access.';

export interface DurableAccessRuleOptions {
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  /**
   * When true, a `capability:<id>` rule whose definition is not (yet) known is
   * accepted. Used by job access requirements, which are setup/preflight
   * assertions and may reference capabilities that are not currently
   * registered. The persistent write path keeps this false so durable grants
   * always bind to a reviewed definition.
   */
  allowUnknownSemanticCapability?: boolean;
}

export function validateDurableAccessRule(
  rule: string,
  options: DurableAccessRuleOptions = {},
): { ok: true } | { ok: false; reason: string } {
  const trimmed = rule.trim();
  if (isGantryMcpWildcardRule(trimmed)) {
    return {
      ok: false,
      reason:
        'Persistent Gantry MCP wildcard grants are not supported; request one exact mcp__gantry__ tool.',
    };
  }

  const scoped = parseReadableScopedToolRule(trimmed);
  if (scoped?.toolName === RUN_COMMAND_TOOL_NAME) {
    if (containsGeneratedRuntimeSkillPath(scoped.scope)) {
      return {
        ok: false,
        reason: GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON,
      };
    }
    if (containsGeneratedRuntimePath(scoped.scope)) {
      return {
        ok: false,
        reason:
          'Persistent RunCommand rules cannot reference generated runtime paths; use a reviewed stable capability or let Gantry-owned runtime scratch reads stay internal.',
      };
    }
  }

  const readableValidation = validateReadableAgentToolRule(trimmed);
  if (!readableValidation.ok) return readableValidation;
  if (isGantryFacadeExactToolRule(trimmed)) return { ok: true };

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
    const broadCommandReason = parsed.leaves
      .map(broadPersistentRunCommandReason)
      .find((reason): reason is string => Boolean(reason));
    if (broadCommandReason) {
      return {
        ok: false,
        reason: `Persistent RunCommand rules require a concrete command prefix before wildcard fallback (${broadCommandReason}); use Allow once or a reviewed semantic capability.`,
      };
    }
    const secretReason = durableBashSecretReason(scoped.scope);
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
    const definition = options.semanticCapabilityDefinitions?.[capabilityId];
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
  if (isDurableSchedulerMcpToolFullName(trimmed)) return { ok: true };

  return {
    ok: false,
    reason: DURABLE_ACCESS_RULE_REJECTION_REASON,
  };
}

export function isDurableAccessRuleAllowed(
  rule: string,
  options?: DurableAccessRuleOptions,
): boolean {
  return validateDurableAccessRule(rule, options).ok;
}

export function formatDurableAccessRulesForUser(
  rules: readonly string[],
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
  } = {},
): string {
  return rules
    .map((rule) => formatDurableAccessRuleForUser(rule, options))
    .join(', ');
}

export function formatDurableAccessRuleForEvent(rule: string): string {
  return formatDurableAccessRuleForUser(rule);
}

export function durableAccessRuleAuditPreview(rule: string): string {
  return formatDurableAccessRuleForUser(rule);
}

function formatDurableAccessRuleForUser(
  rule: string,
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
  } = {},
): string {
  const trimmed = rule.trim();
  const scoped = parseReadableScopedToolRule(trimmed);
  if (scoped?.toolName === RUN_COMMAND_TOOL_NAME) {
    return `matching command access (${truncate(redactSensitiveText(scoped.scope), 120)})`;
  }
  const capabilityId = parseSemanticCapabilityRule(trimmed);
  if (capabilityId) {
    const definition = options.semanticCapabilityDefinitions?.[capabilityId];
    if (definition) return definition.displayName;
  }
  if (isCanonicalBrowserCapabilityRule(trimmed)) return 'Browser';
  const adminName = isAdminMcpToolFullName(trimmed)
    ? trimmed.replace(/^mcp__gantry__/, '').replaceAll(/[._-]+/g, ' ')
    : undefined;
  if (adminName) return `Gantry ${titleCase(adminName)}`;
  const schedulerName = isDurableSchedulerMcpToolFullName(trimmed)
    ? trimmed.replace(/^mcp__gantry__scheduler_/, '').replaceAll(/[._-]+/g, ' ')
    : undefined;
  if (schedulerName) return `Scheduler ${titleCase(schedulerName)}`;
  return truncate(redactSensitiveText(trimmed), 160);
}

function durableBashSecretReason(scope: string): string | null {
  const redacted = redactSensitiveText(scope);
  if (redacted !== scope) return 'redaction_required';
  return (
    classifySensitiveMemoryMaterial(scope) ??
    detectPotentialUnredactedSecret(scope)
  );
}

function broadPersistentRunCommandReason(leaf: BashCommandLeaf): string | null {
  const executable = leaf.argv[0];
  const firstArg = leaf.argv[1];
  if (!executable) return 'missing executable';
  if (!firstArg) return `${executable} has no concrete command argument`;
  if (firstArg === '*') return `${executable} starts with a wildcard argument`;
  return null;
}

function truncate(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : `${value.slice(0, maxLen - 1)}...`;
}

function titleCase(value: string): string {
  return value.trim().replace(/\b\w/g, (char) => char.toUpperCase());
}

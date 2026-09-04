import {
  parseBashCommand,
  type BashCommandLeaf,
} from './bash-command-parser.js';
import {
  capabilityTokens,
  normalizeCapabilityId,
} from './auto-permission-read-only-catalog.js';
import { mcpToolPatternCovers } from './mcp-tool-scope.js';
import {
  classifyPermissionEffectShape,
  PermissionEffectShape,
} from './permission-effect-shape.js';
import {
  evaluateReadHardBoundaries,
  isSecretLikeValue,
} from './permission-hard-boundaries.js';
import { allProtectedPathMentions } from './tool-execution-protected-paths.js';

export interface McpReadBinding {
  capabilityId: string;
  toolPattern: string;
}

export interface AutoPermissionReadOnlyGateInput {
  canonicalToolName: string;
  toolInput: unknown;
  approvedCapabilityIds: readonly string[];
  workspaceRoot?: string;
  reviewedMcpReadBindings?: readonly McpReadBinding[];
}

export interface AutoPermissionReadOnlyGateResult {
  allowed: boolean;
  reason: string;
}

// `;`, `&`, `|` are intentionally absent: they gate the safe-compound path
// (`&&`/`||`/`;`/`|`), which parseBashCommand splits into leaves we vet
// individually. Redirects (`<`/`>`), command substitution (`` ` ``/`$(...)`),
// braces, globs (`*`/`?`/`[]`), and comments (`#`) still block outright.
const SHELL_CONTROL_OR_EXPANSION = /[\r\n#<>`$(){}*?\[\]]/;
const SECRET_KEY =
  /(?:^|[_-])(?:apikey|authorization|credential|key|password|private[_-]?key|secret|token)(?:$|[_-])/i;
const SECRET_VALUE =
  /-----BEGIN [^-]*PRIVATE KEY-----|(?:^|\s)Bearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i;

export function evaluateAutoPermissionReadOnlyGate(
  input: AutoPermissionReadOnlyGateInput,
): AutoPermissionReadOnlyGateResult {
  const capabilityIds = input.approvedCapabilityIds
    .map(normalizeCapabilityId)
    .filter(Boolean);
  if (capabilityIds.length === 0) {
    return blocked('No approved capability boundary covers this action.');
  }

  if (
    input.canonicalToolName === 'Bash' ||
    input.canonicalToolName === 'RunCommand'
  ) {
    return evaluateShellRead(
      input.toolInput,
      capabilityIds,
      input.workspaceRoot,
    );
  }

  return evaluateMcpRead(
    input.canonicalToolName,
    input.toolInput,
    capabilityIds,
    input.reviewedMcpReadBindings,
  );
}

function evaluateShellRead(
  toolInput: unknown,
  capabilityIds: readonly string[],
  workspaceRoot: string | undefined,
): AutoPermissionReadOnlyGateResult {
  const command = commandText(toolInput);
  if (!command) return blocked('Shell command is missing.');
  if (SHELL_CONTROL_OR_EXPANSION.test(command)) {
    return blocked(
      'Shell controls, expansions, redirects, and globs require approval.',
    );
  }
  if (allProtectedPathMentions(command).length > 0) {
    return blocked('Protected paths require approval.');
  }

  const parsed = parseBashCommand(command);
  if (!parsed.ok) {
    return blocked(`Shell command is not provably simple: ${parsed.reason}`);
  }

  const compound = parsed.leaves.length > 1;
  if (!compound) {
    return evaluateLeaf(parsed.leaves[0]!, capabilityIds, workspaceRoot, false);
  }
  // A compound (`&&`/`||`/`;`/`|`) is allowed only when EVERY leaf is a proven
  // safe read; a leaf feeding a pipe legitimately reads stdin, so targets are
  // optional there.
  for (const leaf of parsed.leaves) {
    const result = evaluateLeaf(leaf, capabilityIds, workspaceRoot, true);
    if (!result.allowed) return result;
  }
  return allowed('Parser-proven safe compound read command.');
}

function evaluateLeaf(
  leaf: BashCommandLeaf,
  capabilityIds: readonly string[],
  workspaceRoot: string | undefined,
  stdinOk: boolean,
): AutoPermissionReadOnlyGateResult {
  if (leaf.redirects.length > 0 || leaf.argv.some(isSecretLikeValue)) {
    return blocked('Secret or redirected reads require approval.');
  }
  const shape = classifyPermissionEffectShape(leaf, { stdinOk });
  if (shape.kind === PermissionEffectShape.NotReadOnly) {
    return blocked(shape.reason);
  }
  if (shape.kind === PermissionEffectShape.ReadOnlyCommand) {
    return allowed(`Known-safe command ${shape.executable}.`);
  }
  return evaluateReadHardBoundaries({
    action: shape.action,
    targets: shape.targets,
    requiresTarget: shape.requiresTarget,
    capabilityIds,
    workspaceRoot,
  });
}

function evaluateMcpRead(
  canonicalToolName: string,
  toolInput: unknown,
  capabilityIds: readonly string[],
  reviewedMcpReadBindings: readonly McpReadBinding[] | undefined,
): AutoPermissionReadOnlyGateResult {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_.-]+)$/.exec(
    canonicalToolName,
  );
  if (!match || match[1] === 'gantry') {
    return blocked('Tool family has no deterministic read-only proof.');
  }
  if (containsSecretLikeInput(toolInput)) {
    return blocked('Secret-bearing MCP reads require approval.');
  }

  const toolTokens = capabilityTokens(`${match[1]}.${match[2]}`);
  if (toolTokens.some(isSecretResourceToken)) {
    return blocked('MCP action targets a secret or credential resource.');
  }
  const reviewedBinding = reviewedMcpReadBindings?.find((binding) =>
    mcpToolPatternCovers(binding.toolPattern.trim(), canonicalToolName),
  );
  if (!reviewedBinding) {
    return blocked('MCP action lacks reviewed read-only action metadata.');
  }
  const reviewedCapability = capabilityIds.find(
    (id) => id === normalizeCapabilityId(reviewedBinding.capabilityId),
  );
  if (!reviewedCapability) {
    return blocked(
      'No approved capability boundary covers this reviewed MCP read action.',
    );
  }
  return allowed(`Reviewed MCP read action within ${reviewedCapability}.`);
}

function containsSecretLikeInput(value: unknown, key?: string): boolean {
  if (key && isSecretInputKey(key)) return true;
  if (typeof value === 'string') {
    return isSecretLikeValue(value) || SECRET_VALUE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretLikeInput(item));
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([childKey, child]) =>
    containsSecretLikeInput(child, childKey),
  );
}

// Exact-match selectors that name a profile, never secret material.
const BENIGN_SELECTOR_KEYS = new Set(['credential_profile_ref']);

function isSecretInputKey(key: string): boolean {
  // Secret tokens win over id/name/ref suffixes: secretId, tokenRef, and
  // credentialId all select secret material and must ask.
  const normalized = key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  if (BENIGN_SELECTOR_KEYS.has(normalized)) return false;
  return SECRET_KEY.test(normalized);
}

function isSecretResourceToken(token: string): boolean {
  return /^(?:credential|credentials|key|keys|password|secret|secrets|token|tokens)$/.test(
    token,
  );
}

function commandText(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.cmd;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function allowed(reason: string): AutoPermissionReadOnlyGateResult {
  return { allowed: true, reason };
}

function blocked(reason: string): AutoPermissionReadOnlyGateResult {
  return { allowed: false, reason };
}

import { canonicalJson } from '../shared/canonical-json.js';
import { sha256Hex } from '../shared/stable-hash.js';
import type { PermissionApprovalRequest } from './types.js';

/**
 * Versioned canonical effect key (PERM-2 Task B).
 *
 * Produces a collision-safe hash that Task D uses to cache classifier verdicts.
 * SECURITY-CRITICAL: a collision means one command's ALLOW is reused for a
 * different command, so the hash must characterize the ACTUAL effect exactly.
 *
 * Two invariants:
 *  - We hash the RAW tool input (quotes preserved), never the bash-parser
 *    output — the parser strips quotes and flattens `&&`/pipes, so distinct
 *    commands would collide.
 *  - Every field is length-prefixed so `a|b` can never equal `ab`.
 *
 * Returns `undefined` (⇒ NO caching) whenever the risk-relevant classifier
 * input is unavailable: the toolInput is missing or any classifier-view field
 * was redacted or truncated. Display-only sanitization does not alter the
 * classifier input being hashed.
 */

// Bump on ANY change to the canonicalizer below (field set, order, framing,
// or effect JSON shape). The int lives INSIDE the hash, so a bump invalidates
// every cached row.
export const EFFECT_SCHEMA_VERSION = 3;

// ponytail: no rails/catalog version constant exists in the repo today, so this
// is a standalone int. Bump it whenever the deterministic rails' allow/ask
// floor changes, so a rails tightening invalidates cached classifier verdicts.
// Upgrade path: import a shared RAIL_CATALOG_VERSION here once the rails export one.
export const RAIL_CATALOG_VERSION = 2;

const SHELL_TOOLS = new Set(['Bash', 'RunCommand']);

export interface PermissionEffectHashInput {
  request: PermissionApprovalRequest;
  /**
   * Resolved cwd / workspace-root identity. Relative paths in a command resolve
   * against this, so it is part of the effect. Task D passes the value it
   * already resolves via `resolveWorkspaceFolderPath(sourceAgentFolder)`; when
   * omitted the deterministic `sourceAgentFolder` stands in as cwd identity.
   */
  workspaceRoot?: string;
}

export function computePermissionEffectHash(
  input: PermissionEffectHashInput,
): string | undefined {
  const { request } = input;
  if (inputIsIncomplete(request)) return undefined;
  // Hash the 16K classifier view (not the 500-char display copy) so the cached
  // command matches what the rails evaluated and what the truncation guard covers.
  const toolInput = request.classifierToolInput ?? request.toolInput;
  if (!toolInput) return undefined;

  const cwd = input.workspaceRoot ?? request.sourceAgentFolder;
  // `targetJid` is the parent conversation/channel identity. `threadId` is
  // intentionally excluded so threads inherit their conversation's verdict.
  // Missing targetJid keeps the scope app/provider-account/agent/effect-wide.
  const providerAccountId = request.providerAccountId?.trim() ?? '';
  const conversationId = request.targetJid?.trim() ?? '';
  const canonicalEffect = canonicalEffectJson(request, toolInput, cwd);
  if (canonicalEffect === undefined) return undefined;

  const payload = framePayload([
    String(EFFECT_SCHEMA_VERSION),
    String(RAIL_CATALOG_VERSION),
    request.appId ?? '',
    providerAccountId,
    conversationId,
    request.sourceAgentFolder,
    request.toolName,
    canonicalEffect,
  ]);
  return sha256Hex(payload);
}

/**
 * Canonical, stable serialization of the ACTUAL effect.
 *
 * Shell tools: the raw command string (quotes intact) + the resolved cwd, plus
 * any resolved effect facts already carried on the request. The dest host and
 * target paths live inside the raw command text, so distinct hosts/targets
 * already change the hash without a dedicated field.
 * Non-shell tools: a canonical (sorted-key) JSON of the sanitized tool input.
 */
function canonicalEffectJson(
  request: PermissionApprovalRequest,
  toolInput: Record<string, unknown>,
  cwd: string,
): string | undefined {
  if (SHELL_TOOLS.has(request.toolName)) {
    const command = commandText(toolInput);
    if (command === undefined) return undefined; // no command ⇒ uncacheable
    return canonicalJson({ command, cwd });
  }
  return canonicalJson(toolInput);
}

/** Length-prefix each field so no delimiter collision is possible: `a|b` ≠ `ab`. */
function framePayload(fields: string[]): string {
  return fields
    .map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`)
    .join('\0');
}

function commandText(input: Record<string, unknown>): string | undefined {
  const value = input.command ?? input.cmd;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Cache reuse requires a complete, byte-representative decision input. Without
 * a classifier view, display sanitization is relevant only when its altered
 * paths implicate command/cmd for shell tools, or any field for non-shell
 * tools. With a classifier view, any classifier redaction or truncation keeps
 * the effect uncacheable.
 */
function inputIsIncomplete(request: PermissionApprovalRequest): boolean {
  const ipc = request as PermissionApprovalRequest & {
    toolInputRedactedPaths?: string[];
    toolInputTruncatedPaths?: string[];
  };
  if (!request.toolInput) return true;
  if (!request.classifierToolInput) {
    return SHELL_TOOLS.has(request.toolName)
      ? hasCommandPath(request.toolInputSanitizedPaths)
      : (request.toolInputSanitizedPaths?.length ?? 0) > 0;
  }
  return (
    (ipc.toolInputRedactedPaths?.length ?? 0) > 0 ||
    (ipc.toolInputTruncatedPaths?.length ?? 0) > 0
  );
}

function hasCommandPath(paths: readonly string[] | undefined): boolean {
  return paths?.some((path) => path === 'command' || path === 'cmd') ?? false;
}

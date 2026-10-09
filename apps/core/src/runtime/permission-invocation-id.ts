import { createHash, randomUUID } from 'node:crypto';

import { gantryNativeCanonicalToolName } from '../application/permissions/gantry-tool-risk.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import { canonicalJson } from '../shared/canonical-json.js';

export const INVOCATION_REUSED_REASON =
  'This tool call id was already used for a different action in this run.';

const ENGINE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
// shortcut: in-process bindings; use the waiting record if they must survive a restart.
const MAX_INVOCATION_BINDINGS = 10_000;
const invocationBindings = new Map<
  string,
  { action: string; runKey: string; sourceAgentFolder: string }
>();
const completeActionHashes = new WeakMap<PermissionApprovalRequest, string>();

/** Keep the action digest before IPC redacts or truncates either input view. */
export function capturePermissionInvocationAction<
  T extends PermissionApprovalRequest,
>(request: T, toolInput: unknown): T {
  completeActionHashes.set(
    request,
    permissionActionHash(request.toolName, toolInput),
  );
  return request;
}

/**
 * Pins the engine's tool-call id (SDK tool-use id or LangChain tool-call id)
 * to the authenticated run, app and agent, bound to a hash of the action. A
 * missing or malformed id, or one with no run to scope it, gets a fresh host
 * id. Returns why the call is refused when the id was already used in this
 * run for a different action. The run key comes from the host, never the worker claim.
 */
export function pinPermissionInvocationId(
  request: PermissionApprovalRequest,
  runKey: string | undefined,
): string | undefined {
  const engineId = request.invocationId?.trim();
  if (!engineId || !ENGINE_INVOCATION_ID.test(engineId) || !runKey) {
    request.invocationId = `host:${randomUUID()}`;
    return undefined;
  }
  request.invocationId = engineId;
  const scope = [
    request.appId ?? 'default',
    request.agentId ?? '',
    request.sourceAgentFolder,
    runKey,
    engineId,
  ].join('\u0000');
  const action =
    completeActionHashes.get(request) ??
    permissionActionHash(request.toolName, request.toolInput);
  const bound = invocationBindings.get(scope);
  if (bound !== undefined) {
    return bound.action === action ? undefined : INVOCATION_REUSED_REASON;
  }
  if (invocationBindings.size >= MAX_INVOCATION_BINDINGS) {
    return 'Active runs have reached the tool call limit. Let a run finish, then retry.';
  }
  invocationBindings.set(scope, {
    action,
    runKey,
    sourceAgentFolder: request.sourceAgentFolder,
  });
  return undefined;
}

export function retirePermissionInvocationBindings(input: {
  sourceAgentFolder: string;
  runKey?: string;
}): void {
  if (!input.runKey) return;
  for (const [key, binding] of invocationBindings) {
    if (
      binding.sourceAgentFolder === input.sourceAgentFolder &&
      binding.runKey === input.runKey
    )
      invocationBindings.delete(key);
  }
}

/** The same call under two names (`send_message`, `mcp__gantry__send_message`) hashes the same. */
function permissionActionHash(toolName: string, toolInput: unknown): string {
  const canonicalToolName =
    gantryNativeCanonicalToolName(toolName)?.canonical ?? toolName;
  return createHash('sha256')
    .update(canonicalJson([canonicalToolName, toolInput ?? null]))
    .digest('hex');
}

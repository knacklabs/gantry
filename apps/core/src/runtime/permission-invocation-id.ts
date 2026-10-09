import { createHash, randomUUID } from 'node:crypto';

import { gantryNativeCanonicalToolName } from '../application/permissions/gantry-tool-risk.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import { canonicalJson } from '../shared/canonical-json.js';

export const INVOCATION_REUSED_REASON =
  'This tool call id was already used for a different action in this run.';

const ENGINE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
// ponytail: in-process bindings, oldest evicted past 10k; move them to the
// waiting record if an id must stay bound across a restart.
const MAX_INVOCATION_BINDINGS = 10_000;
const invocationBindings = new Map<string, string>();

/**
 * Pins the engine's tool-call id (SDK tool-use id or LangChain tool-call id)
 * to the authenticated run, app and agent, bound to a hash of the action. A
 * missing or malformed id, or one with no run to scope it, gets a fresh host
 * id. Returns why the call is refused when the id was already used in this
 * run for a different action.
 */
export function pinPermissionInvocationId(
  request: PermissionApprovalRequest,
): string | undefined {
  const engineId = request.invocationId?.trim();
  if (!engineId || !ENGINE_INVOCATION_ID.test(engineId) || !request.runId) {
    request.invocationId = `host:${randomUUID()}`;
    return undefined;
  }
  request.invocationId = engineId;
  const scope = [
    request.appId ?? 'default',
    request.agentId ?? '',
    request.sourceAgentFolder,
    request.runId,
    engineId,
  ].join('\u0000');
  const action = permissionActionHash(request);
  const bound = invocationBindings.get(scope);
  if (bound !== undefined) {
    return bound === action ? undefined : INVOCATION_REUSED_REASON;
  }
  if (invocationBindings.size >= MAX_INVOCATION_BINDINGS) {
    invocationBindings.delete(invocationBindings.keys().next().value!);
  }
  invocationBindings.set(scope, action);
  return undefined;
}

/** The same call under two names (`send_message`, `mcp__gantry__send_message`) hashes the same. */
function permissionActionHash(request: PermissionApprovalRequest): string {
  const toolName =
    gantryNativeCanonicalToolName(request.toolName)?.canonical ??
    request.toolName;
  return createHash('sha256')
    .update(
      canonicalJson([
        toolName,
        request.classifierToolInput ?? request.toolInput ?? null,
      ]),
    )
    .digest('hex');
}

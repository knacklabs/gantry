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
export declare const EFFECT_SCHEMA_VERSION = 3;
export declare const RAIL_CATALOG_VERSION = 2;
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
export declare function computePermissionEffectHash(input: PermissionEffectHashInput): string | undefined;

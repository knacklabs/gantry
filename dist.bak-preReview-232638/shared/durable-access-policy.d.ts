import type { SemanticCapabilityDefinition } from './semantic-capabilities.js';
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
 *   - exact Gantry MCP tools except unscoped dispatchers, delegation
 *     dispatchers, authority/config-changing tools, and decision actors
 *   - scoped `RunCommand(...)` with the bash-parser durable safety rejections
 * Gantry MCP wildcards and generated runtime skill paths are rejected.
 */
export declare const DURABLE_ACCESS_RULE_REJECTION_REASON = "Persistent access approvals support only trusted projected semantic capabilities, canonical Browser, exact Gantry file/web tools, scoped RunCommand(...), or exact Gantry tools except unscoped dispatchers, delegation dispatchers, authority/config-changing tools, and decision actors.";
export declare const AUTHORITY_CHANGING_GANTRY_MCP_TOOL_REJECTION_REASON = "Authority/config-changing Gantry tools cannot be granted persistent access because they can change what an agent is permitted to do, alter runtime configuration or topology, or restart the service; review each request explicitly.";
export declare const DECISION_ACTOR_GANTRY_MCP_TOOL_REJECTION_REASON = "Gantry tools that record a durable user consent or review decision cannot be granted persistent access because the agent must not assert the human decision without per-request review.";
export declare const DURABLE_GRANT_EXCLUDED_DISPATCHER_REJECTION_REASON = "Unscoped Gantry dispatchers cannot be granted persistent access because an exact grant on the dispatcher cannot constrain the arbitrary tool or command it dispatches to; use a scoped command or reviewed target-specific capability instead.";
export declare const DELEGATION_DISPATCHER_REJECTION_REASON = "Gantry delegation dispatchers cannot be granted persistent access because an exact grant cannot bound the tools or commands used by another agent's delegated work; review each delegation or steering request explicitly.";
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
export declare function validateDurableAccessRule(rule: string, options?: DurableAccessRuleOptions): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function isDurableAccessRuleAllowed(rule: string, options?: DurableAccessRuleOptions): boolean;
export declare function formatDurableAccessRulesForUser(rules: readonly string[], options?: {
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): string;
export declare function formatDurableAccessRuleForEvent(rule: string): string;
export declare function durableAccessRuleAuditPreview(rule: string): string;

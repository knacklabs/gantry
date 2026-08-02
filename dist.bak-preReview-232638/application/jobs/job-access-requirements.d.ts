import type { JobAccessRequirement, JobCapabilityRequirement } from '../../domain/types.js';
export interface SplitAccessRequirements {
    toolAccessRequirements: string[];
    capabilityRequirements: JobCapabilityRequirement[];
    requiredMcpServers: string[];
}
/**
 * Validate and normalize the single public job access requirement list.
 * Targets: tool_rule (readable tool rule), capability (semantic capability with
 * optional implementation), or mcp_server (server name/id).
 */
export declare function normalizeAccessRequirementsInput(value: unknown, fieldName?: string): JobAccessRequirement[] | undefined;
export declare function normalizeAccessRequirements(value: unknown, fieldName?: string): JobAccessRequirement[];
/**
 * Derive the three working lists the preflight operates on. The effective
 * tool access rules include the capability-derived `capability:<id>` rules so
 * preflight sees a single canonical allowlist requirement set.
 *
 * NOT pure: this re-normalizes mcp_server targets and rejects unknown target
 * kinds, so it THROWS `ApplicationError('INVALID_REQUEST')` on malformed stored
 * requirements. The readiness service deliberately relies on that throw to emit
 * a "malformed requirement" setup blocker (see job-readiness-service). Callers
 * therefore MUST run inside the readiness preflight, or wrap this in a try/catch
 * that pauses for setup — never let the throw become a hard run failure. The
 * job execution path is safe only because the readiness preflight validates the
 * same requirements (via this function) before the run proceeds; preserve that
 * ordering. (Strict create/update validation still happens in
 * normalizeAccessRequirements.)
 */
export declare function splitAccessRequirements(requirements: readonly JobAccessRequirement[] | undefined): SplitAccessRequirements;

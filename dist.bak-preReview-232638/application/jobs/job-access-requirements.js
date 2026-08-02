import { ApplicationError } from '../common/application-error.js';
import { normalizeRequiredMcpServers, normalizeToolAccessRequirements, } from './job-tool-access-requirements.js';
import { normalizeCapabilityRequirements } from './job-capability-requirements.js';
import { semanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { validateDurableAccessRule } from '../../shared/durable-access-policy.js';
/**
 * Validate and normalize the single public job access requirement list.
 * Targets: tool_rule (readable tool rule), capability (semantic capability with
 * optional implementation), or mcp_server (server name/id).
 */
export function normalizeAccessRequirementsInput(value, fieldName = 'accessRequirements') {
    if (value === undefined)
        return undefined;
    return normalizeAccessRequirements(value, fieldName);
}
export function normalizeAccessRequirements(value, fieldName = 'accessRequirements') {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        throw new ApplicationError('INVALID_REQUEST', `${fieldName} must be an array of access requirements.`);
    }
    const out = [];
    const seen = new Set();
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new ApplicationError('INVALID_REQUEST', `${fieldName} entries must be objects with a target.`);
        }
        const entry = raw;
        const target = entry.target;
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
            throw new ApplicationError('INVALID_REQUEST', `${fieldName} entries require a target object.`);
        }
        const kind = target.kind;
        const reason = typeof entry.reason === 'string' && entry.reason.trim()
            ? entry.reason.trim()
            : undefined;
        let normalized;
        let dedupeKey;
        if (kind === 'tool_rule') {
            const rule = typeof target.rule === 'string'
                ? target.rule.trim()
                : '';
            const validation = validateDurableAccessRule(rule, {
                allowUnknownSemanticCapability: true,
            });
            if (!rule || !validation.ok) {
                throw new ApplicationError('INVALID_REQUEST', `${fieldName} tool_rule target "${rule}" is not supported: ${rule ? validation.reason : 'rule is empty.'}`);
            }
            normalized = {
                target: { kind: 'tool_rule', rule },
                ...(reason ? { reason } : {}),
            };
            dedupeKey = `tool_rule\u0000${rule}`;
        }
        else if (kind === 'capability') {
            const capabilityId = target.capabilityId;
            const implementation = target
                .implementation;
            const [capabilityRequirement] = normalizeCapabilityRequirements([
                {
                    capabilityId: capabilityId,
                    reason: reason ?? 'Required by this job.',
                    implementation,
                },
            ]);
            normalized = {
                target: {
                    kind: 'capability',
                    capabilityId: capabilityRequirement.capabilityId,
                    ...(capabilityRequirement.implementation
                        ? { implementation: capabilityRequirement.implementation }
                        : {}),
                },
                ...(reason ? { reason } : {}),
            };
            dedupeKey = `capability\u0000${capabilityRequirement.capabilityId}\u0000${capabilityRequirement.implementation?.kind ?? ''}\u0000${capabilityRequirement.implementation?.name ?? ''}`;
        }
        else if (kind === 'mcp_server') {
            const [server] = normalizeRequiredMcpServers([target.server], `${fieldName} mcp_server target`);
            normalized = {
                target: { kind: 'mcp_server', server },
                ...(reason ? { reason } : {}),
            };
            dedupeKey = `mcp_server\u0000${server}`;
        }
        else {
            throw new ApplicationError('INVALID_REQUEST', `${fieldName} target.kind must be tool_rule, capability, or mcp_server.`);
        }
        if (seen.has(dedupeKey))
            continue;
        seen.add(dedupeKey);
        out.push(normalized);
    }
    return out;
}
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
export function splitAccessRequirements(requirements) {
    const toolRules = [];
    const capabilityRequirements = [];
    const requiredMcpServers = [];
    for (const requirement of requirements ?? []) {
        const target = requirement.target;
        if (target.kind === 'tool_rule') {
            toolRules.push(target.rule);
        }
        else if (target.kind === 'capability') {
            capabilityRequirements.push({
                capabilityId: target.capabilityId,
                reason: requirement.reason ?? 'Required by this job.',
                ...(target.implementation
                    ? { implementation: target.implementation }
                    : {}),
            });
        }
        else {
            requiredMcpServers.push(target.server);
        }
    }
    return {
        toolAccessRequirements: normalizeToolAccessRequirements([
            ...toolRules,
            ...capabilityRequirements.map((requirement) => semanticCapabilityRule(requirement.capabilityId)),
        ]),
        capabilityRequirements,
        requiredMcpServers: [...new Set(requiredMcpServers)],
    };
}

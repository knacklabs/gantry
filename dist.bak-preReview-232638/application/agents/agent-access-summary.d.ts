import type { AgentToolAccessView } from '../../shared/tool-access-view.js';
export interface AgentAccessSummaryEntry {
    label: string;
    detail: string;
}
export interface AgentAccessSummary {
    /** Active sources used in every conversation. detail = scope label. */
    connected: AgentAccessSummaryEntry[];
    /** Granted access. detail = 'future access' | 'current setup'. */
    allowed: AgentAccessSummaryEntry[];
    /** Plain blockers. label = blocker, detail = one next action. */
    needsAttention: AgentAccessSummaryEntry[];
    /** Conservative removable access. label = access label, detail = reason. */
    suggestedCleanup: AgentAccessSummaryEntry[];
}
export interface AgentAccessSummaryInput {
    sources: {
        skills?: {
            id: string;
            name?: string;
        }[];
        mcpServers?: {
            id: string;
            tools?: string[];
        }[];
        tools?: {
            id: string;
            kind?: string;
        }[];
    };
    selections: {
        id: string;
        version: string;
    }[];
    toolAccess: AgentToolAccessView;
    pendingRequests?: {
        targetLabel: string;
        status: 'pending' | 'expired';
        expiresAt?: string;
    }[];
    disabledToolBindings?: {
        id: string;
    }[];
}
export declare function buildAgentAccessSummary(input: AgentAccessSummaryInput): AgentAccessSummary;
/**
 * Build the read-only summary from raw service inputs. Disabled tool bindings
 * become conservative cleanup suggestions.
 *
 * `pendingRequests` is intentionally not sourced here: `Needs attention` must
 * only show concrete per-agent blockers, and the repository port exposes only
 * app-wide `countPendingAccessRequests`, never a per-agent listing. Populating
 * per-agent pending/expired rows is a deferred follow-up that requires a new
 * `listPendingForAgent({ appId, agentId })` contract on the repository port and
 * adapter. Until then callers pass `pendingRequests` empty — never the app-wide
 * count. See docs/architecture/capability-management.md "Deferred surface impact".
 */
export declare function summarizeAgentAccess(input: {
    sources: AgentAccessSummaryInput['sources'];
    capabilities: {
        id: string;
        version: string;
    }[];
    toolAccess: AgentToolAccessView;
    toolBindings: {
        toolId: unknown;
        status?: string;
    }[];
}): AgentAccessSummary;

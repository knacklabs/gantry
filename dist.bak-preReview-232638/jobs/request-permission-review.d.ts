import type { PermissionApprovalDecision, PermissionApprovalDecisionMode, PermissionApprovalUpdate } from '../domain/types.js';
import type { AppId } from '../domain/app/app.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { formatDurableAccessRulesForUser } from '../shared/durable-access-policy.js';
import { type SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
export interface RequestPermissionReview {
    toolName: 'request_permission';
    displayName: string;
}
interface RequestPermissionReviewOptions {
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}
export declare function requestPermissionQueuedMessage(review: RequestPermissionReview): string;
export declare function requestPermissionDescription(): string;
export declare function requestPermissionReviewEffect(toolInput: Record<string, unknown>, fallback: string): string;
export declare function pendingAccessTargetSummary(review: {
    toolName: string;
    requestKind: string;
    toolInput: Record<string, unknown>;
}): Record<string, string>;
export declare function persistRequestPermissionRules(input: {
    deps: Pick<IpcDeps, 'getToolRepository' | 'getMcpServerRepository' | 'getPermissionRepository' | 'mirrorAgentToolRulesToSettings'>;
    appId?: AppId;
    agentId?: AgentId;
    sourceAgentFolder: string;
    updates: PermissionApprovalUpdate[];
    toolInput?: Record<string, unknown>;
    ipcDir?: string;
    runHandle?: string;
    requestId?: string;
    actor?: string;
    conversationId?: string;
    threadId?: string;
    runId?: string;
    jobId?: string;
    reason?: string;
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): Promise<string[]>;
export declare function isPermanentPermissionDecision(decision: PermissionApprovalDecision): boolean;
export declare function requestPermissionReviewSuggestions(toolInput: Record<string, unknown>, options?: RequestPermissionReviewOptions): PermissionApprovalUpdate[] | undefined;
export declare function requestPermissionTransientLiveRules(toolInput: Record<string, unknown>): string[];
export declare function resolveTrustedSemanticCapabilityDefinitions(input: {
    deps: Pick<IpcDeps, 'getToolRepository' | 'getSkillRepository'>;
    appId: AppId;
    agentId: AgentId;
}): Promise<Record<string, SemanticCapabilityDefinition> | undefined>;
export declare function requestPermissionOnceLiveRules(toolInput: Record<string, unknown>, definitions: Record<string, SemanticCapabilityDefinition> | undefined): string[];
export declare function requestPermissionSetupDecisionOptions(toolInput: Record<string, unknown>, options?: RequestPermissionReviewOptions): PermissionApprovalDecisionMode[];
export { formatDurableAccessRulesForUser };
export declare function validateRequestPermissionSemanticCapability(toolInput: Record<string, unknown>): string | undefined;
export declare function validateRequestPermissionCapabilityProposal(input: {
    capabilityId?: string;
    toolNames: readonly string[];
    capabilityRequestSource?: unknown;
    toolInput: Record<string, unknown>;
}): string | undefined;

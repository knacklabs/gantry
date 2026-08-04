import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerRepository, PermissionRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { ToolCatalogItem } from '../../domain/tools/tools.js';
import { type SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import type { PermissionApprovalDecision, PermissionApprovalUpdate } from '../../domain/types.js';
type MirrorAgentToolRulesToSettings = (sourceAgentFolder: string, rules: string[], options?: {
    appId?: string;
    mode?: 'add' | 'remove';
}) => Promise<void> | void;
export interface PersistentPermissionGrantInput {
    appId: AppId;
    agentId: AgentId;
    sourceAgentFolder: string;
    updates: PermissionApprovalUpdate[];
    toolRepository: ToolCatalogRepository;
    mcpServerRepository?: McpServerRepository;
    mirrorAgentToolRulesToSettings: MirrorAgentToolRulesToSettings;
    permissionRepository?: PermissionRepository;
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
    ipcDir?: string;
    runHandle?: string;
    actor?: string;
    requestId?: string;
    conversationId?: string;
    threadId?: string;
    runId?: string;
    jobId?: string;
    reason?: string;
}
export interface PersistentPermissionRevokeInput {
    appId: AppId;
    agentId: AgentId;
    sourceAgentFolder: string;
    toolRepository: ToolCatalogRepository;
    mirrorAgentToolRulesToSettings: MirrorAgentToolRulesToSettings;
    permissionRepository?: PermissionRepository;
    ipcDir?: string;
    runHandle?: string;
    actor?: string;
    requestId?: string;
    conversationId?: string;
    threadId?: string;
    runId?: string;
    jobId?: string;
    reason?: string;
    toolName?: string;
    toolId?: string;
}
export interface RecordPermissionDecisionInput {
    appId: AppId;
    agentId?: AgentId;
    requestId: string;
    toolName: string;
    decision: PermissionApprovalDecision;
    permissionRepository?: PermissionRepository;
    conversationId?: string;
    threadId?: string;
    runId?: string;
    jobId?: string;
    toolId?: string;
    auditMetadata?: Record<string, unknown>;
}
export declare class PermissionManagementService {
    private readonly clock;
    constructor(clock?: {
        now(): string;
    });
    applyPersistentToolRuleGrant(input: PersistentPermissionGrantInput): Promise<string[]>;
    revokePersistentToolRuleGrant(input: PersistentPermissionRevokeInput): Promise<{
        revokedRule: string;
        toolId: string;
    }>;
    recordDecision(input: RecordPermissionDecisionInput): Promise<void>;
}
export declare function validatePersistentRule(allowedRule: string, options?: {
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): void;
export declare function semanticCapabilityDefinitionsFromToolCatalog(tools: readonly ToolCatalogItem[]): Record<string, SemanticCapabilityDefinition> | undefined;
export {};

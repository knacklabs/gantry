import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
export interface PermissionIpcRuntimeEnv {
    appId: string;
    agentId: string;
    chatJid: string;
    providerAccountId?: string;
    jobId: string;
    jobName: string;
    jobRunId: string;
    jobRunLeaseToken: string;
    jobRunLeaseFencingVersion: string;
    ipcAuthToken: string;
    ipcResponseVerifyKey: string;
    ipcResponseKeyId: string;
    agentRunHandle?: string;
    permissionRequestTimeoutMs: number;
    permissionLane?: 'interactive' | 'autonomous';
    permissionMode?: 'ask' | 'auto' | 'auto_strict';
    senderId?: string;
    senderIsControlApprover?: boolean;
    turnIntentSummary?: string;
    resolveWorkspaceIpcDir: (agentFolder: string) => string;
}
export interface PermissionDecisionResult {
    approved: boolean;
    mode?: 'allow_once' | 'allow_persistent_rule' | 'cancel';
    decidedBy?: string;
    reason?: string;
    risk_level?: 'low' | 'medium' | 'high' | 'critical';
    risk_category?: 'destructive' | 'privileged' | 'secret' | 'network' | 'filesystem' | 'benign';
    updatedPermissions?: unknown[];
    decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
}
export interface PermissionApprovalRequestOptions {
    appId?: string;
    agentId?: string;
    agentFolder: string;
    toolName: string;
    title?: string;
    displayName?: string;
    description?: string;
    decisionReason?: string;
    closestRule?: {
        rule: string;
        reason: string;
    };
    blockedPath?: string;
    toolInput?: unknown;
    hostInjectedCommandPrefix?: string;
    toolUseID?: string;
    agentID?: string;
    suggestions?: unknown[];
    decisionOptions?: readonly string[];
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
    targetJid?: string;
    threadId?: string;
    signal?: AbortSignal;
}
export declare function requestPermissionApprovalViaIpc(env: PermissionIpcRuntimeEnv, options: PermissionApprovalRequestOptions): Promise<PermissionDecisionResult>;

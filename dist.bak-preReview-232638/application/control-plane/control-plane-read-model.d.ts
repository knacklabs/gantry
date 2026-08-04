export type ControlPlaneRuntimeStatus = 'Ready' | 'Needs setup' | 'Blocked';
export type ControlPlaneMemoryStatus = 'Ready' | 'Needs setup' | 'Needs review' | 'Disabled';
export interface ControlPlaneProviderInput {
    id: string;
    label: string;
    ready: boolean;
    blocked?: boolean;
}
export interface ControlPlaneConversationInput {
    id: string;
    agentId?: string;
    ready: boolean;
}
export interface ControlPlaneAgentInput {
    id: string;
    name: string;
    modelAlias: string;
    approvedCapabilities: number;
}
export interface ControlPlaneJobInput {
    id: string;
    agentId?: string;
    status: 'ready' | 'needs_action' | 'blocked';
}
export interface ControlPlaneReadModelInput {
    workspaceKey: string;
    runtimeBlocked?: boolean;
    modelCredentialReady: boolean;
    providers: ControlPlaneProviderInput[];
    conversations: ControlPlaneConversationInput[];
    agents: ControlPlaneAgentInput[];
    jobs: ControlPlaneJobInput[];
    approvedAccessCount: number;
    accessNeedsApprovalCount: number;
    memoryStatus: ControlPlaneMemoryStatus;
}
export interface ControlPlaneSettingsView {
    agent: {
        defaultModel: string;
    };
    agents: Record<string, {
        name: string;
        model?: string;
        capabilities: Array<{
            id: string;
            version: string;
        }>;
    }>;
    conversations: Record<string, unknown>;
    bindings: Record<string, {
        agent: string;
        conversation: string;
    }>;
}
export interface ControlPlaneSettingsReadModelInput {
    settings: ControlPlaneSettingsView;
    workspaceKey: string;
    runtimeBlocked?: boolean;
    modelCredentialReady: boolean;
    providers: ControlPlaneProviderInput[];
    memoryStatus: ControlPlaneMemoryStatus;
    jobs?: ControlPlaneJobInput[];
    accessNeedsApprovalCount?: number;
}
export type ControlPlaneNextAction = {
    kind: 'runtime_blocked';
    label: string;
    params?: Record<string, string>;
} | {
    kind: 'missing_model_credential';
    label: string;
    params?: Record<string, string>;
} | {
    kind: 'missing_provider_connection';
    label: string;
    params?: Record<string, string>;
} | {
    kind: 'missing_conversation_install';
    label: string;
    params?: Record<string, string>;
} | {
    kind: 'missing_access_approval';
    label: string;
    params?: Record<string, string>;
} | {
    kind: 'blocked_job';
    label: string;
    params?: Record<string, string>;
} | {
    kind: 'memory_review_setup';
    label: string;
    params?: Record<string, string>;
} | {
    kind: 'none';
    label: 'none';
    params?: Record<string, string>;
};
export interface ControlPlaneReadModel {
    title: 'Gantry';
    runtime: ControlPlaneRuntimeStatus;
    workspaceKey: string;
    agents: {
        ready: number;
        total: number;
    };
    conversations: {
        ready: number;
        total: number;
    };
    jobs: {
        ready: number;
        needsAction: number;
        blocked: number;
    };
    access: {
        approved: number;
        needsApproval: number;
    };
    memory: ControlPlaneMemoryStatus;
    providers: {
        ready: number;
        needsConnection: number;
        blocked: number;
    };
    nextAction: ControlPlaneNextAction;
    agentDetails: ControlPlaneAgentDetail[];
}
export interface ControlPlaneAgentDetail {
    id: string;
    name: string;
    modelAlias: string;
    workspaceKey: string;
    conversations: number;
    approvedCapabilities: number;
    activeJobs: number;
    memory: ControlPlaneMemoryStatus;
    nextAction: ControlPlaneNextAction;
}
export declare function buildControlPlaneReadModel(input: ControlPlaneReadModelInput): ControlPlaneReadModel;
export declare function buildControlPlaneReadModelFromSettings(input: ControlPlaneSettingsReadModelInput): ControlPlaneReadModel;
export declare function selectControlPlaneNextAction(input: {
    runtimeBlocked: boolean;
    modelCredentialReady: boolean;
    providerCounts: {
        ready: number;
        needsConnection: number;
        blocked: number;
    };
    conversationsReady: number;
    conversationsTotal: number;
    accessNeedsApprovalCount: number;
    blockedJobs: number;
    blockedJobId?: string;
    needsActionJobs?: number;
    needsActionJobId?: string;
    memoryStatus: ControlPlaneMemoryStatus;
}): ControlPlaneNextAction;
export declare function formatControlPlaneStatus(model: ControlPlaneReadModel, service?: {
    kind: string;
    status: string;
}): string;
export declare function formatControlPlaneAgentDetail(detail: ControlPlaneAgentDetail): string;

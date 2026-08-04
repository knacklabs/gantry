import { type SemanticCapabilityDefinition } from './semantic-capabilities.js';
export type ToolExecutionOrigin = 'sdk' | 'mcp' | 'browser' | 'scheduler_script' | 'host';
export type ToolExecutionKind = 'bash' | 'file' | 'mcp' | 'browser' | 'config' | 'scheduler_script' | 'sdk' | 'unknown';
export type ToolExecutionMode = 'interactive' | 'autonomous' | 'host_direct';
export type ToolMutationIntent = 'read' | 'write' | 'delete' | 'execute' | 'configure' | 'unknown';
export type ToolPolicyDecisionStatus = 'allow' | 'deny' | 'needs_approval' | 'not_applicable';
export interface ToolExecutionRequest {
    origin: ToolExecutionOrigin;
    toolKind: ToolExecutionKind;
    toolName: string;
    input: unknown;
    runContext: {
        appId?: string;
        runId?: string;
        agentId?: string;
        conversationId?: string;
        jobId?: string;
        threadId?: string;
    };
    executionMode: ToolExecutionMode;
    targetResource?: string;
    mutationIntent: ToolMutationIntent;
    actionPreview?: string;
}
export interface ToolPolicyDecision {
    status: ToolPolicyDecisionStatus;
    reason: string;
    audit: {
        category: 'tool_execution';
        origin: ToolExecutionOrigin;
        toolKind: ToolExecutionKind;
        toolName: string;
        mutationIntent: ToolMutationIntent;
        targetResource?: string;
        runId?: string;
        jobId?: string;
    };
    recoveryAction?: string;
    matchedRule?: string;
    closestRule?: {
        rule: string;
        reason: string;
    };
}
export declare class ToolExecutionClassifier {
    classify(input: {
        origin: ToolExecutionOrigin;
        toolName: string;
        toolInput: unknown;
        executionMode?: ToolExecutionMode;
        runContext?: ToolExecutionRequest['runContext'];
    }): ToolExecutionRequest;
}
export interface AgentToolExecutionContext {
    isScheduledJob?: boolean;
    jobId?: string;
    threadId?: string;
    conversationId: string;
}
export declare function buildAgentToolExecutionRequest(classifier: ToolExecutionClassifier, toolName: string, toolInput: unknown, context: AgentToolExecutionContext): ToolExecutionRequest;
export declare class ToolExecutionPolicyService {
    evaluate(input: {
        request: ToolExecutionRequest;
        allowedToolRules?: readonly string[];
        autonomousAllowedToolRules?: readonly string[];
        semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
        capabilityRequestToolsHidden?: boolean;
    }): ToolPolicyDecision;
}
export declare function evaluateProtectedCapabilityToolUse(toolName: string, input: unknown): {
    reason: string;
    recoveryAction: string;
} | null;

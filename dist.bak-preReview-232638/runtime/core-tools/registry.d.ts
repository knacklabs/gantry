import type { PermissionApprovalDecision, PermissionApprovalRequest, UserQuestionRequest } from '../../domain/types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { ToolExecutionClassifier, ToolExecutionPolicyService, type ToolPolicyDecision } from '../../shared/tool-execution-policy-service.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';
import { type DurableInteractionOperations } from '../../application/interactions/durable-interaction-handler.js';
import { type CoreSendMessageDeps } from '../../application/core-tools/send-message.js';
import { type CoreTaskLifecycleBackend, type CoreTaskLifecycleResult } from '../../application/core-tools/task-lifecycle.js';
import { type CallableAgentToolManifestEntry } from '../../application/core-tools/callable-agent-tools.js';
import type { CoreToolSchemas } from './schemas.js';
import type { CoreToolDefinition, CoreToolHandlerContext, McpCompatibleToolError, McpCompatibleToolResult } from './contracts.js';
export type { CoreToolDefinition, CoreToolHandlerContext, McpCompatibleToolError, McpCompatibleToolResult, } from './contracts.js';
type CoreToolRule = {
    tool: string;
    action: 'block';
    reason: string;
    when?: {
        arg: string;
        matches: string;
    };
} | {
    tool: string;
    action: 'require_prior';
    prior: string;
    reason: string;
};
interface CoreToolSuccessLedger {
    recordSuccess(toolName: string): void;
    hasSuccess(toolName: string): boolean;
}
export declare const CORE_TOOL_NAMES: readonly ["send_message", "ask_user_question", "memory_search", "memory_save", "delegate_task", "task_get", "task_list", "task_cancel", "task_message"];
export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export declare function inlineCoreToolsMountMcpInventory(): boolean;
export interface CoreToolRunContext {
    sourceAgentFolder: string;
    conversationId: string;
    appId?: string;
    agentId?: string;
    providerAccountId?: string;
    threadId?: string;
    runId?: string;
    jobId?: string;
    runLeaseToken?: string;
    runLeaseFencingVersion?: number;
    isScheduledJob?: boolean;
    memoryDefaultScope?: 'user' | 'group';
    memoryUserId?: string;
    memoryBlock?: string;
    allowedToolRules?: readonly string[];
    autonomousAllowedToolRules?: readonly string[];
    toolRules?: readonly CoreToolRule[];
    toolSuccessLedger?: CoreToolSuccessLedger;
    yoloMode?: YoloModeSettings;
    permissionMode: import('../../shared/permission-mode.js').PermissionMode;
    accessPreset?: 'full' | 'locked';
    fixedImageRestricted?: boolean;
}
export interface CoreToolRegistryDeps extends CoreSendMessageDeps {
    context: CoreToolRunContext;
    requestUserAnswer: (request: UserQuestionRequest) => Promise<{
        requestId: string;
        answers: Record<string, string | string[]>;
        answeredBy?: string;
    }>;
    requestPermissionApproval?: (request: PermissionApprovalRequest) => Promise<PermissionApprovalDecision>;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
    emitAgentOutput?: (output: {
        status: 'success';
        result: null;
        interactionBoundary: 'user_interaction';
    }) => Promise<void> | void;
    taskLifecycleBackend?: CoreTaskLifecycleBackend;
    callableAgentManifest?: readonly CallableAgentToolManifestEntry[];
    dispatchCallableAgent?: (entry: CallableAgentToolManifestEntry, args: Record<string, unknown>) => Promise<CoreTaskLifecycleResult>;
    onPermissionDecision?: (request: PermissionApprovalRequest, decision: PermissionApprovalDecision) => Promise<void> | void;
    onPermissionPromptStarted?: (request: PermissionApprovalRequest) => Promise<void> | void;
    onPermissionPromptFinished?: (request: PermissionApprovalRequest) => Promise<void> | void;
    durability?: DurableInteractionOperations;
    requestId?: (prefix: string) => string;
    evaluateToolPreChecks(input: {
        toolName: string;
        toolInput: unknown;
        memoryBlock: string;
        yoloMode?: YoloModeSettings;
        toolRules?: readonly CoreToolRule[];
        successLedger?: CoreToolSuccessLedger;
    }): {
        reason: string;
        error?: McpCompatibleToolError;
    } | null;
    evaluateToolPolicy(input: {
        classifier: ToolExecutionClassifier;
        policy: ToolExecutionPolicyService;
        toolName: string;
        toolInput: unknown;
        context: {
            conversationId: string;
            threadId?: string;
            jobId?: string;
            isScheduledJob?: boolean;
            yoloMode?: YoloModeSettings;
        };
        allowedToolRules: readonly string[];
        autonomousAllowedToolRules?: readonly string[];
    }): ToolPolicyDecision;
    formatMemorySearchResponse(response: {
        provider?: string;
        data?: unknown;
    }): string;
    formatMemoryWriteResponse(action: string, response: {
        provider?: string;
        data?: unknown;
    }): string;
    schemas: CoreToolSchemas;
}
export declare function createCoreToolRegistry(deps: CoreToolRegistryDeps): {
    tools: readonly CoreToolDefinition[];
    byName: Readonly<Record<string, CoreToolDefinition>>;
    get(name: string): CoreToolDefinition | undefined;
    execute(name: string, input: unknown, context?: CoreToolHandlerContext): Promise<McpCompatibleToolResult>;
};

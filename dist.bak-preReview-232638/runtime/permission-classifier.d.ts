import type { AppId } from '../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { type PermissionClassifierRequestFamily } from '../application/permissions/permission-classifier.js';
import { type PermissionPromotionInput } from '../application/permissions/permission-promotion.js';
import type { MemoryLlmModelProfile } from '../domain/ports/memory-llm-client.js';
import type { PermissionPromotionRepository } from '../domain/ports/permission-promotion.js';
import type { McpReadBinding } from '../shared/auto-permission-read-only-gate.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import * as yolo from '../shared/yolo-mode-policy.js';
import type { PermissionApprovalDecision, PermissionApprovalRequest, PermissionApprovalUpdate, PermissionRiskCategory } from '../domain/types.js';
import { type PermissionClassifierRiskLevel } from './permission-classifier-prompt.js';
export { PERMISSION_CLASSIFIER_MAX_STRING_LENGTH, PERMISSION_CLASSIFIER_MAX_TOOL_INPUT_CHARS, redactPermissionClassifierToolInput, serializePermissionClassifierToolInput, } from './permission-classifier-prompt.js';
export declare const PERMISSION_CLASSIFIER_TIMEOUT_MS = 12000;
export type PermissionClassifierFailureCode = 'llm_unconfigured' | 'timeout' | 'aborted' | 'model_resolution_failure' | 'query_error' | 'parse_failure' | 'validation_failure' | 'input_truncated';
export interface PermissionClassifierInput {
    appId: AppId;
    agentIdentity: {
        id: string;
        name?: string;
        folder?: string;
    };
    turnIntentSummary: string;
    canonicalToolName: string;
    toolInput: unknown;
    policyDecisionReason: string;
    approvedCapabilityIds: string[];
    recentlyApprovedExactToolShape?: boolean;
    recentlyDeniedExactToolShape?: boolean;
    autoModeModel?: string;
    memoryModelConfig: {
        extractor: string;
        modelProfiles?: {
            extractor?: MemoryLlmModelProfile;
        };
    };
    signal?: AbortSignal;
}
export interface PermissionClassifierResult {
    risk_level: PermissionClassifierRiskLevel;
    risk_category?: PermissionRiskCategory;
    reason: string;
    latencyMs: number;
    model?: string;
    failureCode?: PermissionClassifierFailureCode;
}
export interface PublishPermissionClassifierDecisionInput {
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
    appId: RuntimeEventPublishInput['appId'];
    agentId: RuntimeEventPublishInput['agentId'];
    runId: RuntimeEventPublishInput['runId'];
    jobId?: NonNullable<RuntimeEventPublishInput['jobId']>;
    conversationId?: NonNullable<RuntimeEventPublishInput['conversationId']>;
    threadId?: NonNullable<RuntimeEventPublishInput['threadId']>;
    correlationId?: NonNullable<RuntimeEventPublishInput['correlationId']>;
    actor: RuntimeEventPublishInput['actor'];
    intentSource: PermissionClassifierIntentSource;
    toolName: string;
    decision: PermissionClassifierPromptConsultResult['decision'];
    risk_level: PermissionClassifierRiskLevel;
    reason: string;
    latencyMs: number;
    model?: string;
    failureCode?: PermissionClassifierFailureCode;
    suggestionKey?: string;
}
export type PermissionClassifierIntentSource = 'operator_message' | 'runner_summary' | 'none';
export interface PermissionClassifierPromptConsultInput {
    permissionMode: PermissionMode;
    requestFamily: PermissionClassifierRequestFamily;
    appId?: string;
    agentId?: string;
    agentName?: string;
    agentFolder: string;
    runId?: string;
    jobId?: string;
    conversationId?: string;
    threadId?: string;
    correlationId: string;
    actor: RuntimeEventPublishInput['actor'];
    intentSource: PermissionClassifierIntentSource;
    turnIntentSummary: string;
    canonicalToolName: string;
    toolInput: unknown;
    toolInputRedactedPaths?: string[];
    toolInputTruncatedPaths?: string[];
    policyDecisionReason: string;
    approvedCapabilityIds: string[];
    workspaceRoot?: string;
    reviewedMcpReadBindings?: McpReadBinding[];
    yoloMode?: yolo.YoloModeSettings;
    suggestions?: PermissionApprovalUpdate[];
    promotion?: Pick<PermissionPromotionInput, 'repository' | 'offer'>;
    classifierConfig: PermissionClassifierRuntimeConfig;
    signal?: AbortSignal;
    publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
    classifierConsult?: typeof consultPermissionClassifier;
}
export interface PermissionClassifierPromptConsultResult extends PermissionClassifierResult {
    decision: 'allow' | 'ask';
    suggestions?: PermissionApprovalUpdate[];
    suggestionKey?: string;
    promotionHintCount?: number;
    /** Set when the YOLO denylist forced this ask — callers must not offer
     * persistent grants the denylist would never honor. */
    denylistHit?: true;
}
export interface PermissionClassifierRuntimeConfig {
    autoModeModel?: string;
    memoryExtractorModel: string;
}
export declare function consultPermissionClassifier(input: PermissionClassifierInput): Promise<PermissionClassifierResult>;
export declare function consultPermissionClassifierBeforePrompt(input: PermissionClassifierPromptConsultInput): Promise<PermissionClassifierPromptConsultResult | undefined>;
export declare function permissionPromotionHintCount(input: {
    promotion?: PermissionClassifierPromptConsultInput['promotion'];
    appId?: string;
    agentFolder: string;
    canonicalToolName: string;
    toolInput: unknown;
    suggestions?: PermissionApprovalUpdate[];
}): Promise<number | undefined>;
export declare function recordHumanPermissionPromotionSignal(input: {
    repository?: PermissionPromotionRepository;
    appId?: string;
    agentFolder: string;
    request: PermissionApprovalRequest;
    decision: PermissionApprovalDecision;
}): void;
export declare function publishPermissionClassifierDecision(input: PublishPermissionClassifierDecisionInput): Promise<void>;

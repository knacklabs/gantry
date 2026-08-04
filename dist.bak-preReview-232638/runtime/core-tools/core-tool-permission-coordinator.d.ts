import type { PermissionApprovalDecision, PermissionApprovalRequest } from '../../domain/types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { ToolPolicyDecision } from '../../shared/tool-execution-policy-service.js';
import { runDurablePermissionInteraction } from '../../application/interactions/durable-interaction-handler.js';
interface CoreToolPermissionDeps {
    context: {
        sourceAgentFolder: string;
        accessPreset?: 'full' | 'locked';
        fixedImageRestricted?: boolean;
    };
    requestPermissionApproval?: (request: PermissionApprovalRequest) => Promise<PermissionApprovalDecision>;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
    onPermissionDecision?: (request: PermissionApprovalRequest, decision: PermissionApprovalDecision) => Promise<void> | void;
    onPermissionPromptStarted?: (request: PermissionApprovalRequest) => Promise<void> | void;
    onPermissionPromptFinished?: (request: PermissionApprovalRequest) => Promise<void> | void;
    durability?: Parameters<typeof runDurablePermissionInteraction>[0]['operations'];
}
export declare function coordinateCoreToolPermission(input: {
    request: PermissionApprovalRequest;
    hardDenyReason?: string;
    reviewedRuleDecision: ToolPolicyDecision;
    deps: CoreToolPermissionDeps;
}): Promise<PermissionApprovalDecision>;
export {};

import type { PendingInteractionRepository, PermissionPromptGroup } from '../../domain/ports/worker-coordination.js';
import type { PermissionApprovalDecisionMode, PermissionApprovalRequest, PermissionCallbackScope } from '../../domain/types.js';
import { type DurablePermissionFullView } from './pending-interaction-permission-envelope.js';
export { readDurablePermissionFullView } from './pending-interaction-permission-envelope.js';
export type { DurablePermissionFullView } from './pending-interaction-permission-envelope.js';
export { readQuestionRecoveryEnvelope } from './pending-interaction-question-recovery.js';
export type { DurableQuestionCallback } from './pending-interaction-question-recovery.js';
type PromptBindingBackend = {
    repository: PendingInteractionRepository;
    warn?: (context: Record<string, unknown>, message: string) => void;
};
export declare function configurePendingInteractionPromptBinding(next: PromptBindingBackend | null): void;
export declare function bindPendingPermissionInteractionMessage(input: {
    request: PermissionApprovalRequest;
    decisionOptions: PermissionApprovalDecisionMode[];
    callbackId?: string;
    externalMessageId?: string;
    provider?: string | null;
    conversationId?: string | null;
    fullView?: DurablePermissionFullView | null;
}): Promise<boolean>;
export interface DurablePermissionPromptMessageContext {
    scope: PermissionCallbackScope;
    requestId: string;
    matchKind: 'individual' | 'batch';
    providerAlias: string | null;
    sourceAgentFolder: string;
    targetJid: string | null;
    approvalContextJid: string | null;
    threadId: string | null;
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'] | null;
    decisionOptions: PermissionApprovalDecisionMode[];
    request: PermissionApprovalRequest;
    claim?: NonNullable<PermissionPromptGroup['prompt']['claim']>;
}
export declare function findDurablePermissionInteractionByPromptMessage(input: {
    provider: string;
    conversationId: string;
    externalMessageId: string;
    threadId?: string | null;
    appId?: string | null;
    providerAlias?: string;
}): Promise<DurablePermissionPromptMessageContext | null>;

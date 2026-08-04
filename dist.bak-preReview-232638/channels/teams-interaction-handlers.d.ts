import type { PermissionApprovalDecision, PermissionApprovalRequest, PermissionApprovalDecisionMode, UserQuestionCancellation, UserQuestionRequest, UserQuestionResponse } from '../domain/types.js';
import { type InteractionCancellationResult } from './interaction-settlement.js';
import { type PendingTeamsPermissionPrompt, type PendingTeamsUserQuestion, type TeamsChannelOpts, type TeamsInboundMessage, type TeamsSdkClient } from './teams-types.js';
type TeamsInteractionContext = {
    opts: TeamsChannelOpts;
    sdkClient: TeamsSdkClient;
    pendingPermissionPrompts: Map<string, PendingTeamsPermissionPrompt>;
    pendingUserQuestions: Map<string, PendingTeamsUserQuestion>;
};
export declare function dropPendingTeamsInteraction(context: TeamsInteractionContext, kind: 'permission' | 'question', request: PermissionApprovalRequest | UserQuestionRequest): void;
export declare function handleTeamsUserQuestionSubmit(input: {
    message: TeamsInboundMessage;
    jid: string;
    userId: string;
    userName: string;
    context: TeamsInteractionContext;
}): Promise<boolean>;
export declare function resolvePendingTeamsUserQuestion(context: TeamsInteractionContext, providerAlias: string, response: UserQuestionResponse, emptyReceiptText?: string): Promise<void>;
export declare function cancelPendingTeamsQuestion(context: TeamsInteractionContext, cancellation: UserQuestionCancellation): Promise<InteractionCancellationResult>;
export declare function handleTeamsPermissionDecision(input: {
    message: TeamsInboundMessage;
    jid: string;
    userId: string;
    userName: string;
    context: TeamsInteractionContext;
}): Promise<boolean>;
export declare function resolveTeamsPermissionPrompt(context: TeamsInteractionContext, providerAlias: string, decision: PermissionApprovalDecision): Promise<boolean>;
export declare function settlePendingTeamsPermission(context: TeamsInteractionContext, providerAlias: string, mode: PermissionApprovalDecisionMode, approverRef: string, reason?: string): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
export {};

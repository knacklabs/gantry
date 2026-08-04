import { PermissionApprovalCancellation, PermissionApprovalDecision, PermissionApprovalRequest } from '../../domain/types.js';
import { SlackChannelState, SlackMessageLike } from './channel-state.js';
export declare abstract class SlackChannelInteractions extends SlackChannelState {
    cancelPendingPermission(cancellation: PermissionApprovalCancellation): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
    protected ingestSlackSlashCommand(command: {
        channel_id?: string;
        user_id?: string;
        user_name?: string;
        text?: string;
        trigger_id?: string;
        command_id?: string;
    }): Promise<void>;
    protected ingestSlackMessage(event: SlackMessageLike, options?: {
        forceOwnedTopLevel?: boolean;
    }): Promise<void>;
    protected canDecidePermission(userId: string, sourceAgentFolder: string, decisionPolicy?: PermissionApprovalRequest['decisionPolicy'], conversationJid?: string, threadId?: string, providerAccountId?: string | undefined): Promise<boolean>;
    protected resolvePermissionPrompt(providerAlias: string, decision: PermissionApprovalDecision, respond?: (payload: Record<string, unknown>) => Promise<unknown>, settleInternally?: boolean): Promise<boolean>;
    protected timeoutPermissionPrompt(providerAlias: string, retryWindowMs: number): Promise<void>;
    protected claimAndResolvePermissionPrompt(providerAlias: string, mode: NonNullable<PermissionApprovalDecision['mode']>, approverRef: string, respond?: (payload: Record<string, unknown>) => Promise<unknown>, reason?: string, settleInternally?: boolean): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
    private terminalizePermissionPrompt;
    protected registerBoltHandlers(options?: {
        inbound?: boolean;
    }): void;
}

import type { App } from '@slack/bolt';
import type { PermissionApprovalDecision, PermissionApprovalRequest } from '../../domain/types.js';
import type { PendingPermissionPrompt } from './channel-state.js';
import type { ChannelOpts } from '../channel-provider.js';
export declare function slackPermissionApproverIds(runtimeSettings: ChannelOpts['runtimeSettings'], providerAccountId: string | undefined, channelId: string): string[];
export declare function requestSlackPermissionApproval(input: {
    app: App;
    jid: string;
    channelId: string;
    request: PermissionApprovalRequest;
    timeoutMs: number;
    approverUserIds?: readonly string[];
    pendingPermissionPrompts: Map<string, PendingPermissionPrompt>;
    timeoutPermissionPrompt: (providerAlias: string, retryWindowMs: number) => Promise<void>;
    onPromptDelivered?: (messageId: string) => void;
}): Promise<PermissionApprovalDecision>;

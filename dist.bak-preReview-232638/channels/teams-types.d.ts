import type { ChannelOpts } from './channel-provider.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import type { PermissionApprovalDecision, PermissionApprovalRequest, PermissionCallbackScope, UserQuestionRequest, UserQuestionResponse } from '../domain/types.js';
import type { TeamsAdaptiveCardPayload } from './teams-cards.js';
import type { DurableQuestionCallback } from '../application/interactions/pending-interaction-durability.js';
export declare const TEAMS_JID_PREFIX = "teams:";
export interface TeamsChannelCredentials {
    clientId: string;
    clientSecret: string;
    tenantId: string;
}
export interface TeamsInboundMessage {
    conversationId: string;
    id?: string;
    text?: string;
    name?: string;
    value?: unknown;
    from?: {
        id?: string;
        name?: string;
    };
    senderId?: string;
    senderName?: string;
    timestamp?: string;
    threadId?: string;
    replyToId?: string;
    conversationName?: string;
    conversationType?: string;
    attachments?: TeamsMessageAttachment[];
}
export interface TeamsMessageAttachment {
    id?: string;
    contentType?: string;
    sizeBytes?: number;
}
export type TeamsContextMessage = TeamsInboundMessage;
export interface TeamsSdkMessageListInput {
    conversationId: string;
    beforeMessageId?: string;
    limit: number;
}
export interface TeamsSdkMessageGetInput {
    conversationId: string;
    messageId: string;
}
export interface TeamsSdkReplyListInput extends TeamsSdkMessageListInput {
    messageId: string;
}
export interface TeamsSdkStartInput {
    credentials: TeamsChannelCredentials;
    onMessage: (message: TeamsInboundMessage) => Promise<void>;
}
export interface TeamsSdkSendResult {
    externalMessageId?: string;
}
export interface TeamsSdkOutboundMessage {
    conversationId: string;
    text: string;
    threadId?: string;
}
export interface TeamsSdkAdaptiveCardMessage {
    conversationId: string;
    card: TeamsAdaptiveCardPayload;
    threadId?: string;
    streamType?: 'informative' | 'streaming';
}
export interface TeamsSdkAdaptiveCardUpdate {
    conversationId: string;
    messageId: string;
    card: TeamsAdaptiveCardPayload;
    threadId?: string;
    streamType?: 'informative' | 'streaming';
}
export interface TeamsSdkClient {
    start(input: TeamsSdkStartInput): Promise<void>;
    stop(): Promise<void>;
    sendMessage(input: TeamsSdkOutboundMessage): Promise<TeamsSdkSendResult>;
    listChannelMessages?(input: TeamsSdkMessageListInput): Promise<TeamsContextMessage[]>;
    getChannelMessage?(input: TeamsSdkMessageGetInput): Promise<TeamsContextMessage>;
    listChannelMessageReplies?(input: TeamsSdkReplyListInput): Promise<TeamsContextMessage[]>;
    sendAdaptiveCard?(input: TeamsSdkAdaptiveCardMessage): Promise<TeamsSdkSendResult>;
    updateAdaptiveCard?(input: TeamsSdkAdaptiveCardUpdate): Promise<TeamsSdkSendResult>;
}
export interface TeamsChannelDependencies {
    sdkClient?: TeamsSdkClient;
    credentials?: TeamsChannelCredentials;
}
export type TeamsChannelOpts = Pick<ChannelOpts, 'onMessage' | 'onChatMetadata' | 'isControlApproverAllowed' | 'onMessageAction' | 'providerAccountId' | 'agentId'>;
export interface PendingTeamsPermissionPrompt {
    callback: TeamsPermissionCallback;
    conversationId: string;
    messageId?: string;
    sourceAgentFolder: string;
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
    approvalContextJid?: string;
    request: PermissionApprovalRequest;
    threadId?: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (decision: PermissionApprovalDecision) => void;
    settled: boolean;
}
export interface TeamsPermissionCallback {
    providerAlias: string;
    scope: PermissionCallbackScope;
    matchKind: 'individual' | 'batch';
}
export interface PendingTeamsUserQuestion {
    callback: DurableQuestionCallback;
    conversationId: string;
    sourceAgentFolder: string;
    request: UserQuestionRequest;
    threadId?: string;
    messageId?: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (response: UserQuestionResponse) => void;
    settled: boolean;
}
export declare function normalizeTeamsJid(input: string): string | null;
export declare function isTeamsJid(input: string): boolean;
export declare function teamsConversationIdFromJid(jid: string): string | null;
export declare function readTeamsCredentials(secrets?: RuntimeSecretProvider, settings?: {
    providerAccounts: Record<string, {
        provider: string;
        runtimeSecretRefs: Record<string, string | undefined>;
    } | undefined>;
}, providerAccountId?: string): Promise<TeamsChannelCredentials | null>;

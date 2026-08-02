import { App } from '@slack/bolt';
import { NewMessage, PermissionApprovalDecision, PermissionApprovalRequest, PermissionCallbackScope, RichInteractionRequest, UserQuestionCancellation, UserQuestionRequest } from '../../domain/types.js';
import { ChannelOpts } from '../channel-provider.js';
import { StreamResetEpochs } from '../stream-reset-epochs.js';
import { hydrateSlackConversationContext } from './conversation-context.js';
import type { DurableQuestionCallback } from '../../application/interactions/pending-interaction-durability.js';
import { type InteractionCancellationResult } from '../interaction-settlement.js';
interface SlackAttachmentDownload {
    filePath: string;
    storageRef: string;
}
type SlackMessageAttachments = NonNullable<NewMessage['attachments']>;
type UQSelection = {
    selected: string | string[];
    answeredBy?: string;
};
type PendingPermissionPromptMap = Map<string, PendingPermissionPrompt>;
export interface ActiveStreamState {
    channelId: string;
    threadId?: string;
    rawBuffer: string;
    lastSentText: string;
    lastNativeText: string;
    messageTs?: string;
    fallbackMessageTs: string[];
    nativeStreamTs?: string;
    nativeEnabled: boolean;
    lastFlushAt: number;
}
export interface ActiveProgressState {
    channelId: string;
    threadId?: string;
    messageTs?: string;
    lastText: string;
    generation?: number;
}
export interface PendingPermissionPrompt {
    callback: {
        providerAlias: string;
        scope: PermissionCallbackScope;
        matchKind: 'individual' | 'batch';
    };
    channelId: string;
    sourceAgentFolder: string;
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
    approvalContextJid?: string;
    request: PermissionApprovalRequest;
    messageTs: string;
    timer?: ReturnType<typeof setTimeout>;
    resolve: (decision: PermissionApprovalDecision) => void;
    settled: boolean;
}
export interface PendingUserQuestionState {
    callback: DurableQuestionCallback;
    requestId: string;
    questionIndex: number;
    question: UserQuestionRequest['questions'][number];
    promptText: string;
    selectedOptionIndexes: Set<number>;
    channelId: string;
    sourceAgentFolder: string;
    messageTs: string;
    timer?: ReturnType<typeof setTimeout>;
    resolve: (selection: UQSelection) => void;
    settled: boolean;
}
export interface SlackMessageLike {
    channel?: string;
    ts?: string;
    thread_ts?: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
    text?: string;
    files?: Array<{
        id?: string;
        name?: string;
        title?: string;
        mimetype?: string;
        url_private?: string;
        url_private_download?: string;
    }>;
    client_msg_id?: string;
    edited?: unknown;
}
export declare abstract class SlackChannelState {
    name: string;
    protected app: App | null;
    protected readonly botToken: string;
    protected readonly appToken: string;
    protected readonly opts: Pick<ChannelOpts, 'onMessage' | 'onChatMetadata' | 'conversationRoutes' | 'runtimeSettings' | 'isControlApproverAllowed' | 'onMessageAction' | 'providerAccountId' | 'agentId'>;
    protected botUserId: string | null;
    protected userNameCache: Map<string, string>;
    protected channelNameCache: Map<string, string>;
    protected activeStreams: Map<string, ActiveStreamState>;
    protected readonly streamResetEpochs: StreamResetEpochs;
    protected streamGenerationByJid: Map<string, number>;
    protected sealedStreamGenerationByJid: Map<string, number>;
    protected activeProgress: Map<string, ActiveProgressState>;
    protected sealedProgressGenerationByKey: Map<string, number>;
    protected progressStateLoaded: boolean;
    protected pendingPermissionPrompts: PendingPermissionPromptMap;
    protected pendingUserQuestions: Map<string, PendingUserQuestionState>;
    protected pendingTodos: Map<string, {
        channel: string;
        ts: string;
    }>;
    protected pendingRichForms: Map<string, RichInteractionRequest>;
    dropPendingInteraction(kind: 'permission' | 'question', request: PermissionApprovalRequest | UserQuestionRequest): void;
    cancelPendingQuestion(cancellation: UserQuestionCancellation): Promise<InteractionCancellationResult>;
    constructor(botToken: string, appToken: string, opts: ChannelOpts);
    protected streamKey(jid: string, threadId?: string): string;
    protected progressKey(jid: string, threadId?: string): string;
    protected shouldAcceptProgressUpdate(key: string, generation?: number, done?: boolean): boolean;
    protected markProgressGenerationDone(key: string, generation?: number): void;
    protected pendingUserQuestionKey(callback: DurableQuestionCallback): string;
    protected formatUserQuestionPromptText(request: UserQuestionRequest, question: UserQuestionRequest['questions'][number], timeoutMs: number): string;
    protected buildUserQuestionBlocks(pending: PendingUserQuestionState): Array<Record<string, unknown>>;
    protected parseUserQuestionActionValue(rawValue: string | undefined): {
        callback: DurableQuestionCallback;
        optionIndex?: number;
    } | null;
    protected refreshUserQuestionPrompt(pending: PendingUserQuestionState): Promise<void>;
    protected finalizeUserQuestionPrompt(pending: PendingUserQuestionState, selection: string | string[], answeredBy?: string, reason?: string): Promise<void>;
    protected clearStreamingStateForJid(jid: string): void;
    protected shouldAcceptStreamingChunk(jid: string, generation?: number): boolean;
    protected markStreamingGenerationDone(jid: string, generation?: number): void;
    protected sealStreamingGenerationOnReset(jid: string): void;
    protected isCurrentStreamingGeneration(jid: string, generation?: number): boolean;
    protected parseJid(jid: string): {
        channelId: string;
    } | null;
    protected isLikelyGroupConversation(channelId: string): boolean;
    protected resolveUserName(userId: string | undefined): Promise<string>;
    protected resolveChannelName(channelId: string): Promise<string>;
    protected sanitizeFilename(raw: string): string;
    protected downloadSlackAttachment(jid: string, file: {
        name?: string;
        title?: string;
        url_private?: string;
        url_private_download?: string;
    }, threadId?: string, targetFolder?: string): Promise<SlackAttachmentDownload | null>;
    protected enrichMessage(jid: string, event: SlackMessageLike, targetFolder?: string): Promise<{
        text: string;
        attachments: SlackMessageAttachments;
    }>;
    hydrateConversationContext(request: Parameters<typeof hydrateSlackConversationContext>[0]): Promise<import("../channel-provider.js").ConversationContextHydrationResult>;
    protected tryNativeStreamStart(channelId: string, threadId: string | undefined, text: string): Promise<string | undefined>;
    protected tryNativeStreamAppend(channelId: string, streamTs: string, text: string): Promise<{
        completed: boolean;
        sentPrefix: string;
    }>;
    protected tryNativeStreamStop(channelId: string, streamTs: string): Promise<boolean>;
}
export {};

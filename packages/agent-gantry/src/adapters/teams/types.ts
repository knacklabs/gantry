import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationReference, TurnContext } from 'botbuilder';
import type {
  GantryDispatchResult,
  GantryLogger,
  GantryRuntimeMessageRecord,
  GantryStructuredTaskAuditRecord,
  GantryStructuredTaskRunner,
} from '../../shared/types.js';

export type {
  GantryAgentTaskAttachment,
  GantryAgentTaskAttachmentRequest,
  GantryAgentTaskCancellationRequest,
  GantryAgentTaskInput,
  GantryAgentTaskResult,
  GantryAgentTaskStep,
  GantryAgentTool,
  GantryAgentToolContext,
  GantryBrowserGatewayActAction,
  GantryBrowserGatewayActRequest,
  GantryBrowserGatewayInspectMode,
  GantryBrowserGatewayInspectRequest,
  GantryBrowserGatewayOpenRequest,
  GantryBrowserGatewayRequest,
  GantryBrowserGatewayToolName,
  GantryBrowserGatewayToolProvider,
  GantryBrowserInspectInput,
  GantryBrowserInspectResult,
  GantryClientConfig,
  GantryCrawlToolInput,
  GantryCrawlToolResult,
  GantryDispatchResult,
  GantryDelegatedAgentTaskHandle,
  GantryDelegatedAgentTaskInput,
  GantryDelegatedAgentTaskLookup,
  GantryDelegatedAgentTaskResult,
  GantryDocumentExtractInput,
  GantryDocumentExtractResult,
  GantryExternalPlatformEventRequest,
  GantryFetchToolInput,
  GantryFetchToolResult,
  GantryLogger,
  GantryRuntimeMessageRecord,
  GantrySearchResultItem,
  GantrySearchToolInput,
  GantrySearchToolResult,
  GantrySignatureInput,
  GantrySignatureVerificationInput,
  GantryStructuredTaskAuditRecord,
  GantryStructuredTaskInput,
  GantryStructuredTaskResult,
  GantryStructuredTaskRunner,
  GantryToolBudget,
  GantryWebhookSignatureVerificationInput,
  FirecrawlCrawlProviderConfig,
  FirecrawlFetchProviderConfig,
  FirecrawlSearchProviderConfig,
  HttpFetchProviderConfig,
  StructuredBrowserToolProvider,
  StructuredCrawlToolProvider,
  StructuredDocumentExtractToolProvider,
  StructuredFetchToolProvider,
  StructuredJsonModelProvider,
  StructuredModelTaskRunnerConfig,
  StructuredSearchToolProvider,
  StructuredToolProviderSet,
  TavilySearchProviderConfig,
} from '../../shared/types.js';

export interface GantryRuntimeStorage {
  recordMessage?(input: GantryRuntimeMessageRecord): Promise<void> | void;
  recordStructuredTaskRun?(
    input: GantryStructuredTaskAuditRecord,
  ): Promise<void> | void;
  getUserConversationState?(
    input: GantryUserConversationStateKey,
  ):
    | Promise<GantryUserConversationState | null>
    | GantryUserConversationState
    | null;
  upsertUserConversationState?(
    input: GantryUserConversationStateUpsertInput,
  ): Promise<GantryUserConversationState> | GantryUserConversationState;
  mergeUserConversationState?(
    input: GantryUserConversationStateMergeInput,
  ): Promise<GantryUserConversationState> | GantryUserConversationState;
  getTeamsConversationReference?(
    conversationId: string,
  ):
    | Promise<GantryTeamsStoredConversationReference | null>
    | GantryTeamsStoredConversationReference
    | null;
  getTeamsPersonalConversationReference?(
    input: GantryTeamsPersonalConversationLookup,
  ):
    | Promise<GantryTeamsStoredConversationReference | null>
    | GantryTeamsStoredConversationReference
    | null;
  saveTeamsConversationReference?(
    reference: GantryTeamsStoredConversationReference,
  ): Promise<void> | void;
}

export interface GantryTeamsTransport {
  sendCard(
    input: GantryEmbeddedTeamsCardRequest,
  ): Promise<GantryDispatchResult> | GantryDispatchResult;
  sendDm(
    input: GantryEmbeddedTeamsDmRequest,
  ): Promise<GantryDispatchResult> | GantryDispatchResult;
  sendThreadReply(
    input: GantryTeamsThreadReplyRequest,
  ): Promise<GantryDispatchResult> | GantryDispatchResult;
  handleIncomingActivity?(
    input: GantryTeamsIncomingActivityInput,
  ): Promise<GantryTeamsIncomingActivity> | GantryTeamsIncomingActivity;
  handleHttpActivity?(
    input: GantryTeamsHttpActivityInput,
  ): Promise<void> | void;
}

export interface GantryRuntimeConfig {
  readonly storage?: GantryRuntimeStorage;
  readonly teams?: GantryTeamsTransport;
  readonly tasks?: GantryStructuredTaskRunner;
  readonly signing?: {
    readonly teamsRequestSecret?: string | null;
    readonly internalEventSecret?: string | null;
  };
  readonly logger?: GantryLogger;
}

export interface GantryEmbeddedTeamsCardRequest {
  readonly conversationId: string;
  readonly card: Record<string, unknown>;
  readonly correlationId?: string | null;
}

export interface GantryEmbeddedTeamsDmRequest {
  readonly teamsUserId: string;
  readonly teamsTenantId?: string | null;
  readonly text?: string | null;
  readonly card?: Record<string, unknown> | null;
  readonly correlationId?: string | null;
}

export interface GantryTeamsIncomingActivityInput {
  readonly rawBody?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly activity: Record<string, unknown>;
}

export interface GantryTeamsHttpActivityInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly onActivity: (
    activity: GantryTeamsIncomingActivity,
  ) => Promise<void> | void;
}

export interface GantryTeamsIncomingActivity {
  readonly provider: 'teams';
  readonly type: 'message' | 'invoke' | 'unknown';
  readonly messageId: string;
  readonly conversationId: string;
  readonly replyToId?: string | null;
  readonly text?: string | null;
  readonly value?: unknown;
  readonly teamsTenantId?: string | null;
  readonly teamsUserId?: string | null;
  readonly teamsUserDisplayName?: string | null;
  readonly raw: Record<string, unknown>;
}

export interface GantryUserConversationStateKey {
  readonly provider: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly conversationScopeType: string;
  readonly conversationScopeId: string;
}

export interface GantryUserConversationState extends GantryUserConversationStateKey {
  readonly summaryText: string;
  readonly stateJson: Record<string, unknown>;
  readonly lastSubjectId?: string | null;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GantryUserConversationStateUpsertInput extends GantryUserConversationStateKey {
  readonly summaryText?: string | null;
  readonly stateJson?: Record<string, unknown> | null;
  readonly lastSubjectId?: string | null;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly updatedAt?: string | null;
}

export type GantryUserConversationStateMergeInput =
  GantryUserConversationStateUpsertInput;

export interface GantryExternalNotificationCardRequest {
  readonly integrationId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly target: {
    readonly teamsChannelId: string;
    readonly scopeId?: string | null;
    readonly scopeName?: string | null;
  };
  readonly payload: Record<string, unknown>;
}

export interface GantryTeamsThreadReplyRequest {
  readonly conversationId: string;
  readonly replyToId: string;
  readonly text: string;
  readonly path?: string;
}

export interface GantryTeamsConversationReferenceStatus {
  readonly exists: boolean;
  readonly conversationId: string;
  readonly conversationJid?: string | null;
  readonly tenantId?: string | null;
  readonly botId?: string | null;
  readonly updatedAt?: string | null;
}

export interface GantryTeamsStoredConversationReference extends GantryTeamsConversationReferenceStatus {
  readonly serviceUrl?: string | null;
  readonly rawReferenceJson?: string | null;
  readonly teamsUserId?: string | null;
}

export interface GantryTeamsPersonalConversationLookup {
  readonly teamsUserId: string;
  readonly teamsTenantId?: string | null;
}

export interface GantryBotFrameworkTeamsTransportConfig {
  readonly botAppId: string;
  readonly botAppPassword: string;
  readonly botTenantId?: string | null;
  readonly storage: GantryRuntimeStorage;
  readonly adapter?: BotFrameworkAdapterLike;
  readonly logger?: GantryLogger;
}

export interface BotFrameworkAdapterLike {
  processActivity(
    req: IncomingMessage,
    res: unknown,
    logic: (context: TurnContext) => Promise<void>,
  ): Promise<void>;
  continueConversation(
    reference: Partial<ConversationReference>,
    logic: (context: TurnContext) => Promise<void>,
  ): Promise<void>;
  createConversation?(
    reference: Partial<ConversationReference>,
    parameters: {
      readonly isGroup?: boolean;
      readonly members?: readonly unknown[];
    },
    logic: (context: TurnContext) => Promise<void>,
  ): Promise<void>;
}

export interface GantryPgRuntimeStorageConfig {
  readonly pool: {
    query(
      sql: string,
      values?: readonly unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  };
  readonly schema?: string;
}

export interface GantryExternalCardAction {
  readonly integrationId: string;
  readonly eventId: string;
  readonly subjectId: string;
  readonly scopeId: string;
  readonly sourceScopeId?: string | null;
  readonly sourceConversationId: string;
  readonly teamsTenantId: string;
  readonly actionType: string;
  readonly platformOperation: string;
  readonly requestId?: string | null;
  readonly signatureVersion?: 'v2' | null;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export interface GantryExternalCardActionSigningInput {
  readonly integrationId: string;
  readonly eventId: string;
  readonly subjectId: string | null;
  readonly scopeId: string | null;
  readonly sourceScopeId?: string | null;
  readonly sourceConversationId: string | null;
  readonly teamsTenantId: string | null;
  readonly actionType: string;
  readonly platformOperation?: string | null;
  readonly requestId?: string | null;
  readonly signatureVersion?: 'v2' | null;
  readonly nonce?: string;
  readonly expiresAt?: string;
  readonly nowMs?: number;
}

export interface GantryExternalCardActionVerificationInput {
  readonly action: GantryExternalCardAction;
  readonly secret: string;
  readonly nowMs?: number;
}

export interface GantryExternalNotificationAdaptiveCardInput {
  readonly integrationId: string;
  readonly eventId: string;
  readonly target?: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly actionSecret: string;
  readonly nowMs?: number;
}

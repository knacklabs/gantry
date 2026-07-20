import type { operations } from './generated/openapi.js';

type JsonRequest<Operation extends keyof operations> =
  operations[Operation] extends {
    requestBody: { content: { 'application/json': infer Request } };
  }
    ? Request
    : never;

type JsonResponse<
  Operation extends keyof operations,
  Status extends number,
> = operations[Operation] extends { responses: infer Responses }
  ? Status extends keyof Responses
    ? Responses[Status] extends {
        content: { 'application/json': infer Response };
      }
      ? Response
      : never
    : never
  : never;

type Query<Operation extends keyof operations> = operations[Operation] extends {
  parameters: { query?: infer Parameters };
}
  ? NonNullable<Parameters>
  : never;

export type HealthResponse = JsonResponse<'getHealth', 200>;
export type DoctorResponse = JsonResponse<'getDoctor', 200>;
export type ProcessRole = HealthResponse['processRole'];

export type LlmMessagesRequest = JsonRequest<'invokeLlmMessages'>;
export type LlmMessagesResponse = JsonResponse<'invokeLlmMessages', 200>;
export type LlmMessagesCountTokensRequest =
  JsonRequest<'invokeLlmMessagesCountTokens'>;
export type LlmMessagesCountTokensResponse = JsonResponse<
  'invokeLlmMessagesCountTokens',
  200
>;
export type LlmChatCompletionsRequest = JsonRequest<'invokeLlmChatCompletions'>;
export type LlmChatCompletionsResponse = JsonResponse<
  'invokeLlmChatCompletions',
  200
>;

export type EnsureSessionRequest = JsonRequest<'ensureSession'>;
export type EnsureSessionResponse = JsonResponse<'ensureSession', 200>;
export type ResponseMode = NonNullable<EnsureSessionRequest['responseMode']>;
export type GetSessionResponse = JsonResponse<'getSession', 200>;
export type ListSessionMessagesQuery = Query<'listSessionMessages'>;
export type ListSessionMessagesResponse = JsonResponse<
  'listSessionMessages',
  200
>;
export type SendSessionMessageRequest = JsonRequest<'sendSessionMessage'>;
export type SendSessionMessageResponse = JsonResponse<
  'sendSessionMessage',
  202
>;
export type SendSessionMessageInput = SendSessionMessageRequest & {
  sessionId: string;
};
export type ListSessionEventsQuery = Query<'listOrStreamSessionEvents'>;
export type ListSessionEventsResponse = JsonResponse<
  'listOrStreamSessionEvents',
  200
>;
export type SessionEventStreamOptions = ListSessionEventsQuery & {
  signal?: AbortSignal;
};
export type WaitForSessionEventQuery = Query<'waitForSessionEvent'>;
export type WaitForSessionEventResponse = JsonResponse<
  'waitForSessionEvent',
  200
>;
export type ListSessionRunsResponse = JsonResponse<'listSessionRuns', 200>;

export type ListJobsResponse = JsonResponse<'listJobs', 200>;
export type ListJobEventsResponse = JsonResponse<'listJobEvents', 200>;
export type DeleteJobResponse = JsonResponse<'deleteJob', 200>;
export type PauseJobResponse = JsonResponse<'pauseJob', 200>;
export type ResumeJobResponse = JsonResponse<'resumeJob', 200>;
export type TriggerJobResponse = JsonResponse<'triggerJob', 202>;

export type ListRunsQuery = Query<'listRuns'>;
export type ListRunsResponse = JsonResponse<'listRuns', 200>;
export type GetRunResponse = JsonResponse<'getRun', 200>;

export type QueryUsageQuery = Query<'queryUsage'>;
export type QueryUsageResponse = JsonResponse<'queryUsage', 200>;

export type ListProvidersResponse = JsonResponse<'listProviders', 200>;
export type CreateProviderAccountResponse = JsonResponse<
  'createProviderAccount',
  201
>;
export type ListProviderAccountsResponse = JsonResponse<
  'listProviderAccounts',
  200
>;
export type GetProviderAccountResponse = JsonResponse<
  'getProviderAccount',
  200
>;
export type UpdateProviderAccountResponse = JsonResponse<
  'updateProviderAccount',
  200
>;
export type DisableProviderAccountResponse = JsonResponse<
  'disableProviderAccount',
  200
>;
export type DiscoverProviderConversationsResponse = JsonResponse<
  'discoverProviderConversations',
  200
>;

export type ListConversationsQuery = Query<'listConversations'>;
export type ListConversationsResponse = JsonResponse<'listConversations', 200>;
export type GetConversationResponse = JsonResponse<'getConversation', 200>;
export type ListConversationApproversResponse = JsonResponse<
  'listConversationApprovers',
  200
>;
export type ReplaceConversationApproversRequest =
  JsonRequest<'replaceConversationApprovers'>;
export type ReplaceConversationApproversResponse = JsonResponse<
  'replaceConversationApprovers',
  200
>;
export type ListConversationMessagesQuery = Query<'listConversationMessages'>;
export type ListConversationMessagesResponse = JsonResponse<
  'listConversationMessages',
  200
>;

export type ListConversationInstallsResponse = JsonResponse<
  'listConversationInstalls',
  200
>;
export type EnableConversationInstallResponse = JsonResponse<
  'enableConversationInstall',
  200
>;
export type UpdateConversationInstallResponse = JsonResponse<
  'updateConversationInstall',
  200
>;
export type DisableConversationInstallQuery =
  Query<'disableConversationInstall'>;
export type DisableConversationInstallResponse = JsonResponse<
  'disableConversationInstall',
  200
>;

export type GetAgentDelegatesResponse = JsonResponse<'getAgentDelegates', 200>;
export type ReplaceAgentDelegatesRequest = JsonRequest<'replaceAgentDelegates'>;
export type ReplaceAgentDelegatesResponse = JsonResponse<
  'replaceAgentDelegates',
  200
>;

export type CreateWebhookRequest = JsonRequest<'createWebhook'>;
export type CreateWebhookResponse = JsonResponse<'createWebhook', 201>;
export type ListWebhooksResponse = JsonResponse<'listWebhooks', 200>;
export type UpdateWebhookRequest = JsonRequest<'updateWebhook'>;
export type UpdateWebhookResponse = JsonResponse<'updateWebhook', 200>;
export type DeleteWebhookResponse = JsonResponse<'deleteWebhook', 200>;
export type TestWebhookResponse = JsonResponse<'testWebhook', 202>;
export type ReplayWebhookDeadLettersResponse = JsonResponse<
  'replayWebhookDeadLetters',
  200
>;
export type PurgeWebhookDeadLettersResponse = JsonResponse<
  'purgeWebhookDeadLetters',
  200
>;

export type CreateMemoryResponse = JsonResponse<'createMemory', 201>;
export type SearchMemoryResponse = JsonResponse<'searchMemory', 200>;
export type ListMemoryResponse = JsonResponse<'listMemory', 200>;
export type PatchMemoryResponse = JsonResponse<'patchMemory', 200>;
export type DeleteMemoryResponse = JsonResponse<'deleteMemory', 200>;
export type TriggerMemoryDreamingRequest = JsonRequest<'triggerMemoryDreaming'>;
export type MemorySubjectType = NonNullable<
  TriggerMemoryDreamingRequest['subjectType']
>;
export type DreamPhase = NonNullable<TriggerMemoryDreamingRequest['phase']>;
export type TriggerMemoryDreamingResponse = JsonResponse<
  'triggerMemoryDreaming',
  202
>;
export type MemoryDreamingStatusResponse = JsonResponse<
  'getMemoryDreamingStatus',
  200
>;

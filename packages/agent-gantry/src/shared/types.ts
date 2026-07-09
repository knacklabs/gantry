export interface GantryClientConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly eventSecret?: string | null;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface GantryLogger {
  debug?(meta: Record<string, unknown>, message: string): void;
  info?(meta: Record<string, unknown>, message: string): void;
  warn?(meta: Record<string, unknown>, message: string): void;
  error?(meta: Record<string, unknown>, message: string): void;
}

export interface GantryDispatchResult {
  readonly accepted: boolean;
  readonly statusCode: number;
  readonly body?: unknown;
}

export interface GantryRuntimeMessageRecord {
  readonly provider: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId?: string | null;
  readonly text?: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly occurredAt: string;
}

export interface GantryStructuredTaskInput {
  readonly taskType: string;
  readonly instructions: string;
  readonly input: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly correlationId?: string | null;
}

export interface GantryStructuredTaskResult {
  readonly status: 'completed' | 'needs_review' | 'failed';
  readonly output: Record<string, unknown>;
  readonly validationReport?: Record<string, unknown> | null;
  readonly warnings?: readonly string[];
  readonly modelUsage?: GantryStructuredModelUsage | null;
}

export interface GantryStructuredTaskAuditRecord {
  readonly taskRunId: string;
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly status: GantryStructuredTaskResult['status'];
  readonly input: Record<string, unknown>;
  readonly output?: Record<string, unknown> | null;
  readonly validationReport?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly occurredAt: string;
}

export interface GantryStructuredTaskStorage {
  recordStructuredTaskRun?(
    input: GantryStructuredTaskAuditRecord,
  ): Promise<void> | void;
}

export interface GantryStructuredTaskRunner {
  runStructuredTask(
    input: GantryStructuredTaskInput,
  ): Promise<GantryStructuredTaskResult>;
  runAgentTask?(input: GantryAgentTaskInput): Promise<GantryAgentTaskResult>;
  delegateAgentTask?(
    input: GantryDelegatedAgentTaskInput,
  ): Promise<GantryDelegatedAgentTaskHandle>;
  getDelegatedAgentTask?(
    input: GantryDelegatedAgentTaskLookup,
  ): Promise<GantryDelegatedAgentTaskResult>;
}

export interface GantryAgentToolContext {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly state: Record<string, unknown>;
}

export interface GantryAgentTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  execute(
    input: Record<string, unknown>,
    context: GantryAgentToolContext,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface GantryAgentTaskInput {
  readonly taskType: string;
  readonly instructions: string;
  readonly input: Record<string, unknown>;
  readonly tools: readonly GantryAgentTool[];
  readonly finalSchema?: Record<string, unknown>;
  readonly cacheablePrefix?: string | null;
  readonly promptCache?: GantryPromptCacheConfig | null;
  readonly correlationId?: string | null;
  readonly maxSteps?: number;
  readonly deadlineAt?: string | null;
  readonly stepTimeoutMs?: number;
  readonly modelStepTimeoutMs?: number;
  readonly toolStepTimeoutMs?: number;
  readonly getStepAttachments?: (
    input: GantryAgentTaskAttachmentRequest,
  ) =>
    | Promise<readonly GantryAgentTaskAttachment[]>
    | readonly GantryAgentTaskAttachment[];
  readonly buildStepInstructions?: (
    input: GantryAgentTaskStepInstructionsRequest,
  ) => Promise<string> | string;
  readonly selectStepTools?: (
    input: GantryAgentTaskToolSelectionRequest,
  ) =>
    | Promise<readonly string[] | null | undefined>
    | readonly string[]
    | null
    | undefined;
  readonly projectStepStateForModel?: (
    input: GantryAgentTaskModelStateProjectionRequest,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  readonly recoverFromToolError?: (
    input: GantryAgentTaskToolErrorRecoveryRequest,
  ) =>
    | Promise<GantryAgentTaskToolErrorRecoveryResult | null | undefined>
    | GantryAgentTaskToolErrorRecoveryResult
    | null
    | undefined;
  readonly validateFinal?: (
    input: GantryAgentTaskFinalValidationRequest,
  ) =>
    | Promise<GantryAgentTaskFinalValidationResult>
    | GantryAgentTaskFinalValidationResult;
  readonly shouldCancel?: (
    input: GantryAgentTaskCancellationRequest,
  ) => Promise<boolean> | boolean;
  readonly onStep?: (step: GantryAgentTaskStep) => Promise<void> | void;
}

export type GantryAgentGoalEvaluationStatus =
  | 'passed'
  | 'failed'
  | 'partial'
  | 'not_evaluated';

export interface GantryAgentPreviousGoalEvaluation {
  readonly goal: string | null;
  readonly status: GantryAgentGoalEvaluationStatus;
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}

export type GantryAgentFailedActionRetryPolicy =
  | 'do_not_repeat'
  | 'retry_after_new_evidence'
  | 'safe_to_retry';

export interface GantryAgentFailedAction {
  readonly step: number;
  readonly toolName?: string | null;
  readonly fingerprint?: string | null;
  readonly reason: string;
  readonly retryPolicy: GantryAgentFailedActionRetryPolicy;
}

export interface GantryAgentNextGoal {
  readonly goal: string;
  readonly requiredEvidence: readonly string[];
  readonly recommendedTool?: string | null;
}

export type GantryAgentBrowserVisualFreshness =
  | 'current'
  | 'previous'
  | 'missing'
  | 'mismatch';

export interface GantryAgentCurrentBrowserState {
  readonly step?: number | null;
  readonly toolName?: string | null;
  readonly url?: string | null;
  readonly title?: string | null;
  readonly snapshotId?: string | null;
  readonly stateRef?: string | null;
  readonly screenshotRef?: string | null;
  readonly visualFreshness: GantryAgentBrowserVisualFreshness;
  readonly openSurfaces?: readonly Record<string, unknown>[];
  readonly activeSurface?: Record<string, unknown> | null;
  readonly blockingOverlay?: Record<string, unknown> | null;
  readonly selectedAction?: Record<string, unknown> | null;
  readonly lastActionResult?: Record<string, unknown> | null;
  readonly stateOverview?: Record<string, unknown> | null;
  readonly candidateInventory?: Record<string, unknown> | null;
  readonly lastStateWindow?: Record<string, unknown> | null;
  readonly actionCandidates?: readonly Record<string, unknown>[];
}

export interface GantryAgentMemory {
  readonly mainGoal: string;
  readonly currentGoal: string;
  readonly previousGoalEvaluation: GantryAgentPreviousGoalEvaluation;
  readonly durableFacts: Record<string, unknown>;
  readonly failedActions: readonly GantryAgentFailedAction[];
  readonly nextGoal: GantryAgentNextGoal;
  readonly currentBrowserState?: GantryAgentCurrentBrowserState | null;
  readonly compactionEvents?: readonly Record<string, unknown>[];
}

export interface GantryAgentTaskAttachment {
  readonly label?: string | null;
  readonly mimeType: string;
  readonly base64?: string | null;
  readonly localPath?: string | null;
  readonly purpose?: string | null;
  readonly sourceStep?: number | null;
}

export interface GantryAgentTaskCancellationRequest {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly state: Record<string, unknown>;
  readonly phase: 'before_model' | 'before_tool' | 'after_tool';
  readonly toolName?: string | null;
}

export interface GantryAgentTaskFinalValidationRequest {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly state: Record<string, unknown>;
  readonly output: Record<string, unknown>;
  readonly source: 'model_final' | 'tool_final_output';
  readonly toolName?: string | null;
}

export interface GantryAgentTaskFinalValidationResult {
  readonly accepted: boolean;
  readonly reason?: string | null;
  readonly instruction?: string | null;
  readonly details?: Record<string, unknown> | null;
}

export interface GantryAgentTaskAttachmentRequest {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly state: Record<string, unknown>;
}

export interface GantryAgentTaskStepInstructionsRequest {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly state: Record<string, unknown>;
}

export interface GantryAgentTaskToolSelectionRequest {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly maxSteps: number;
  readonly state: Record<string, unknown>;
  readonly tools: readonly GantryAgentTool[];
}

export interface GantryAgentTaskModelStateProjectionRequest {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly state: Record<string, unknown>;
  readonly tools: readonly GantryAgentTool[];
  readonly attempt: 'primary' | 'timeout_retry' | 'tool_error_recovery';
  readonly error?: string | null;
}

export interface GantryAgentTaskToolErrorRecoveryRequest {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly state: Record<string, unknown>;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly error: string;
  readonly tools: readonly GantryAgentTool[];
}

export interface GantryAgentTaskToolErrorRecoveryResult {
  readonly instructions?: string | null;
  readonly tools?: readonly GantryAgentTool[];
  readonly attempt?: 'tool_error_recovery';
}

export interface GantryAgentTaskStep {
  readonly step: number;
  readonly actionType: string;
  readonly toolName?: string | null;
  readonly status: 'completed' | 'failed' | 'skipped';
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly durationMs: number;
  readonly observation?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly promptMetrics?: Record<string, unknown> | null;
  readonly actionInput?: Record<string, unknown> | null;
  readonly auditNote?: string | null;
  readonly whyThisStep?: string | null;
  readonly expectedOutcome?: string | null;
  readonly nextIfFails?: string | null;
  readonly visualSummary?: string | null;
  readonly visibleTarget?: string | null;
  readonly whyThisAction?: string | null;
  readonly expectedStateChange?: string | null;
  readonly fallbackIfWrong?: string | null;
  readonly previousGoalEvaluation?: Record<string, unknown> | null;
  readonly memoryUpdate?: Record<string, unknown> | null;
  readonly nextGoal?: Record<string, unknown> | null;
}

export interface GantryAgentTaskResult {
  readonly status: 'completed' | 'needs_review' | 'failed';
  readonly output: Record<string, unknown>;
  readonly validationReport?: Record<string, unknown> | null;
  readonly steps: readonly GantryAgentTaskStep[];
  readonly warnings?: readonly string[];
  readonly modelUsage?: GantryStructuredModelUsage | null;
}

export type GantryBrowserGatewayToolName =
  | 'browser_status'
  | 'browser_open'
  | 'browser_inspect'
  | 'browser_act'
  | 'browser_verify_document_action'
  | 'browser_list_state_sections'
  | 'browser_read_controls'
  | 'browser_read_table'
  | 'browser_search_state'
  | 'browser_read_element'
  | 'browser_read_text_chunks'
  | 'browser_scroll_to_state_element'
  | 'browser_close';

export type GantryBrowserGatewayInspectMode =
  | 'snapshot'
  | 'screenshot'
  | 'tabs'
  | 'console'
  | 'network';

export type GantryBrowserGatewayActAction =
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'click'
  | 'type'
  | 'fill'
  | 'select'
  | 'wait'
  | 'keyboard'
  | 'screenshot'
  | 'tab_new'
  | 'tab_select'
  | 'tab_close'
  | 'dialog';

export interface GantryBrowserGatewayRequest {
  readonly toolName: GantryBrowserGatewayToolName;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly timeoutMs?: number | null;
  readonly context: GantryAgentToolContext;
}

export interface GantryBrowserGatewayOpenRequest extends GantryBrowserGatewayRequest {
  readonly url?: string | null;
  readonly profileKey?: string | null;
}

export interface GantryBrowserGatewayInspectRequest extends GantryBrowserGatewayRequest {
  readonly mode: GantryBrowserGatewayInspectMode;
  readonly tabId?: string | null;
  readonly reason?: string | null;
}

export interface GantryBrowserGatewayActRequest extends GantryBrowserGatewayRequest {
  readonly action: GantryBrowserGatewayActAction;
  readonly tabId?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly reason?: string | null;
}

export interface GantryBrowserGatewayVerifyDocumentActionRequest extends GantryBrowserGatewayRequest {
  readonly tabId?: string | null;
  readonly selector?: string | null;
  readonly ref?: string | null;
  readonly snapshotId?: string | null;
  readonly text?: string | null;
  readonly label?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly reason?: string | null;
}

export interface GantryBrowserGatewayStateRequest extends GantryBrowserGatewayRequest {
  readonly snapshotId?: string | null;
  readonly stateRef?: string | null;
  readonly family?: string | null;
  readonly cursor?: string | number | null;
  readonly limit?: number | null;
  readonly query?: string | null;
  readonly families?: readonly string[];
  readonly tableId?: string | number | null;
  readonly rowCursor?: string | number | null;
  readonly elementId?: string | null;
  readonly ref?: string | null;
  readonly selector?: string | null;
  readonly queryOrCursor?: string | null;
  readonly tabId?: string | null;
}

export interface GantryBrowserGatewayToolProvider {
  status(
    input: GantryBrowserGatewayRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  open(
    input: GantryBrowserGatewayOpenRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  inspect(
    input: GantryBrowserGatewayInspectRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  act(
    input: GantryBrowserGatewayActRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  verifyDocumentAction?(
    input: GantryBrowserGatewayVerifyDocumentActionRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  listStateSections?(
    input: GantryBrowserGatewayStateRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  readControls?(
    input: GantryBrowserGatewayStateRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  readTable?(
    input: GantryBrowserGatewayStateRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  searchState?(
    input: GantryBrowserGatewayStateRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  readElement?(
    input: GantryBrowserGatewayStateRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  readTextChunks?(
    input: GantryBrowserGatewayStateRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  scrollToStateElement?(
    input: GantryBrowserGatewayStateRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  close(
    input: GantryBrowserGatewayRequest,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface GantryExternalPlatformEventRequest {
  readonly integrationId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
  readonly target?: Record<string, unknown>;
}

export interface StructuredJsonModelProvider {
  generateJson(input: {
    readonly taskType: string;
    readonly instructions: string;
    readonly input: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly cacheablePrefix?: string | null;
    readonly promptCache?: GantryPromptCacheConfig | null;
    readonly correlationId?: string | null;
    readonly attachments?: readonly GantryAgentTaskAttachment[];
  }): Promise<StructuredJsonModelProviderResult>;
}

export interface GantryPromptCacheConfig {
  readonly enabled?: boolean;
  readonly ttl?: '5m' | '1h';
  readonly prefixHash?: string | null;
}

export interface GantryStructuredModelUsage {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly taskType?: string | null;
  readonly correlationId?: string | null;
  readonly promptCharCount?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly cachedTokens?: number | null;
  readonly cacheCreationInputTokens?: number | null;
  readonly cacheReadInputTokens?: number | null;
  readonly promptCacheTtl?: '5m' | '1h' | null;
  readonly promptCachePrefixHash?: string | null;
  readonly durationMs?: number | null;
  readonly usageSource?: 'provider' | 'estimated' | string;
}

export type StructuredJsonModelProviderResult =
  | Record<string, unknown>
  | string
  | {
      readonly output: Record<string, unknown> | string;
      readonly modelUsage?: GantryStructuredModelUsage | null;
    };

export interface GantryDelegatedAgentTaskInput {
  readonly objective: string;
  readonly context?: string | null;
  readonly expectedOutput?: string | null;
  readonly cacheablePrefix?: string | null;
  readonly promptCache?: GantryPromptCacheConfig | null;
  readonly timeoutMs?: number | null;
  readonly correlationId?: string | null;
}

export interface GantryDelegatedAgentTaskHandle {
  readonly taskId: string;
  readonly status?:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  readonly summary?: string | null;
}

export interface GantryDelegatedAgentTaskLookup {
  readonly taskId: string;
  readonly wait?: boolean;
  readonly timeoutMs?: number | null;
}

export interface GantryDelegatedAgentTaskResult {
  readonly taskId: string;
  readonly status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  readonly output?: Record<string, unknown> | null;
  readonly outputText?: string | null;
  readonly error?: string | null;
  readonly summary?: string | null;
}

export type AnthropicStructuredModelEffort =
  | 'off'
  | 'low'
  | 'medium'
  | 'high'
  | 'max';

export interface AnthropicStructuredModelTaskPolicy {
  readonly model?: string | null;
  readonly maxTokens?: number | null;
  readonly effort?: AnthropicStructuredModelEffort | null;
  readonly temperature?: number | null;
}

export interface AnthropicStructuredModelConfig {
  readonly provider: 'anthropic';
  readonly apiKey?: string | null;
  readonly model?: string | null;
  readonly defaultModel?: string | null;
  readonly taskModels?: Record<string, string | null | undefined>;
  readonly taskPolicies?: Record<
    string,
    AnthropicStructuredModelTaskPolicy | null | undefined
  >;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly apiVersion?: string;
}

export type GantryStructuredModelConfig =
  | StructuredJsonModelProvider
  | AnthropicStructuredModelConfig;

export interface StructuredBrowserToolProvider {
  runTask?(input: GantryStructuredTaskInput): Promise<Record<string, unknown>>;
  inspect?(
    input: GantryBrowserInspectInput,
  ): Promise<GantryBrowserInspectResult>;
}

export interface GantryToolBudget {
  readonly timeoutMs?: number;
  readonly maxResults?: number;
  readonly maxBytes?: number;
  readonly maxPages?: number;
}

export interface GantrySearchToolInput {
  readonly query: string;
  readonly limit?: number;
  readonly budget?: GantryToolBudget;
  readonly correlationId?: string | null;
}

export interface GantrySearchResultItem {
  readonly url: string;
  readonly title?: string | null;
  readonly snippet?: string | null;
  readonly source?: string | null;
}

export interface GantrySearchToolResult {
  readonly items: readonly GantrySearchResultItem[];
  readonly provider?: string | null;
  readonly warnings?: readonly string[];
}

export interface StructuredSearchToolProvider {
  search(input: GantrySearchToolInput): Promise<GantrySearchToolResult>;
}

export interface GantryMapToolInput {
  readonly url: string;
  readonly limit?: number;
  readonly budget?: GantryToolBudget;
  readonly correlationId?: string | null;
}

export interface GantryMapToolResult {
  readonly startUrl: string;
  readonly links: ReadonlyArray<{
    readonly url: string;
    readonly title?: string | null;
    readonly source?: string | null;
  }>;
  readonly provider?: string | null;
  readonly warnings?: readonly string[];
}

export interface StructuredMapToolProvider {
  map(input: GantryMapToolInput): Promise<GantryMapToolResult>;
}

export interface GantryFetchToolInput {
  readonly url: string;
  readonly budget?: GantryToolBudget;
  readonly correlationId?: string | null;
}

export interface GantryFetchToolResult {
  readonly url: string;
  readonly statusCode?: number | null;
  readonly contentType?: string | null;
  readonly title?: string | null;
  readonly text?: string | null;
  readonly blockedReason?:
    | 'login_required'
    | 'captcha'
    | 'robots'
    | 'dead'
    | 'parked'
    | 'unsupported'
    | string
    | null;
  readonly provider?: string | null;
  readonly warnings?: readonly string[];
}

export interface StructuredFetchToolProvider {
  fetch(input: GantryFetchToolInput): Promise<GantryFetchToolResult>;
}

export interface GantryCrawlToolInput {
  readonly url: string;
  readonly limit?: number;
  readonly budget?: GantryToolBudget;
  readonly correlationId?: string | null;
}

export interface GantryCrawlToolResult {
  readonly startUrl: string;
  readonly pages: ReadonlyArray<{
    readonly url: string;
    readonly title?: string | null;
    readonly text?: string | null;
    readonly blockedReason?: string | null;
  }>;
  readonly provider?: string | null;
  readonly warnings?: readonly string[];
}

export interface StructuredCrawlToolProvider {
  crawl(input: GantryCrawlToolInput): Promise<GantryCrawlToolResult>;
}

export interface GantryBrowserInspectInput {
  readonly url: string;
  readonly instructions?: string | null;
  readonly budget?: GantryToolBudget;
  readonly correlationId?: string | null;
}

export interface GantryBrowserInspectResult {
  readonly url: string;
  readonly title?: string | null;
  readonly text?: string | null;
  readonly screenshotRef?: string | null;
  readonly blockedReason?:
    | 'login_required'
    | 'captcha'
    | 'dead'
    | 'unsupported'
    | string
    | null;
  readonly provider?: string | null;
  readonly warnings?: readonly string[];
}

export interface GantryDocumentExtractInput {
  readonly url?: string | null;
  readonly contentType?: string | null;
  readonly bytes?: Uint8Array;
  readonly text?: string | null;
  readonly budget?: GantryToolBudget;
  readonly correlationId?: string | null;
}

export interface GantryDocumentExtractResult {
  readonly text?: string | null;
  readonly metadata?: Record<string, unknown> | null;
  readonly provider?: string | null;
  readonly warnings?: readonly string[];
}

export interface StructuredDocumentExtractToolProvider {
  extract(
    input: GantryDocumentExtractInput,
  ): Promise<GantryDocumentExtractResult>;
}

export interface StructuredToolProviderSet {
  readonly search?: StructuredSearchToolProvider;
  readonly map?: StructuredMapToolProvider;
  readonly fetch?: StructuredFetchToolProvider;
  readonly crawl?: StructuredCrawlToolProvider;
  readonly browser?: StructuredBrowserToolProvider;
  readonly documentExtract?: StructuredDocumentExtractToolProvider;
}

export interface StructuredModelTaskRunnerConfig {
  readonly model: GantryStructuredModelConfig;
  readonly browser?: StructuredBrowserToolProvider;
  readonly tools?: StructuredToolProviderSet;
  readonly storage?: GantryStructuredTaskStorage;
}

export interface TavilySearchProviderConfig {
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResults?: number;
}

export interface HttpFetchProviderConfig {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface FirecrawlCrawlProviderConfig {
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
}

export interface FirecrawlSearchProviderConfig {
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResults?: number;
  readonly searchMode?: 'lightweight' | 'scrape';
}

export interface FirecrawlFetchProviderConfig {
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface FirecrawlMapProviderConfig {
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxLinks?: number;
}

export interface FirecrawlDiscoveryToolProviderSetConfig {
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResults?: number;
  readonly maxPages?: number;
  readonly maxLinks?: number;
  readonly fetchMode?: 'http' | 'firecrawl';
  readonly searchMode?: 'lightweight' | 'scrape';
}

export interface GantrySignatureInput {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly rawBody: string;
}

export interface GantrySignatureVerificationInput extends GantrySignatureInput {
  readonly signature: string;
  readonly nowMs?: number;
  readonly toleranceMs?: number;
}

export interface GantryWebhookSignatureVerificationInput {
  readonly secret: string;
  readonly timestamp: string;
  readonly eventId: string | number;
  readonly eventType: string;
  readonly rawBody: string;
  readonly signature: string;
  readonly nowMs?: number;
  readonly toleranceMs?: number;
}

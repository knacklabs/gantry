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
  readonly correlationId?: string | null;
  readonly maxSteps?: number;
  readonly deadlineAt?: string | null;
  readonly stepTimeoutMs?: number;
  readonly getStepAttachments?: (
    input: GantryAgentTaskAttachmentRequest,
  ) =>
    | Promise<readonly GantryAgentTaskAttachment[]>
    | readonly GantryAgentTaskAttachment[];
  readonly shouldCancel?: (
    input: GantryAgentTaskCancellationRequest,
  ) => Promise<boolean> | boolean;
  readonly onStep?: (step: GantryAgentTaskStep) => Promise<void> | void;
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

export interface GantryAgentTaskAttachmentRequest {
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly step: number;
  readonly state: Record<string, unknown>;
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
}

export interface GantryAgentTaskResult {
  readonly status: 'completed' | 'needs_review' | 'failed';
  readonly output: Record<string, unknown>;
  readonly validationReport?: Record<string, unknown> | null;
  readonly steps: readonly GantryAgentTaskStep[];
  readonly warnings?: readonly string[];
}

export type GantryBrowserGatewayToolName =
  | 'browser_status'
  | 'browser_open'
  | 'browser_inspect'
  | 'browser_act'
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
    readonly correlationId?: string | null;
    readonly attachments?: readonly GantryAgentTaskAttachment[];
  }): Promise<Record<string, unknown> | string>;
}

export interface AnthropicStructuredModelConfig {
  readonly provider: 'anthropic';
  readonly apiKey?: string | null;
  readonly model?: string | null;
  readonly defaultModel?: string | null;
  readonly taskModels?: Record<string, string | null | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
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

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ActivityTypes,
  BotFrameworkAdapter,
  TurnContext,
  type Activity,
  type ConversationReference,
  type ResourceResponse,
} from "botbuilder";

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

export interface GantryRuntimeStorage {
  recordMessage?(input: GantryRuntimeMessageRecord): Promise<void> | void;
  recordStructuredTaskRun?(input: GantryStructuredTaskAuditRecord): Promise<void> | void;
  getTeamsConversationReference?(
    conversationId: string,
  ): Promise<GantryTeamsStoredConversationReference | null> | GantryTeamsStoredConversationReference | null;
  getTeamsPersonalConversationReference?(
    input: GantryTeamsPersonalConversationLookup,
  ): Promise<GantryTeamsStoredConversationReference | null> | GantryTeamsStoredConversationReference | null;
  saveTeamsConversationReference?(
    reference: GantryTeamsStoredConversationReference,
  ): Promise<void> | void;
}

export interface GantryTeamsTransport {
  sendCard(input: GantryEmbeddedTeamsCardRequest): Promise<GantryDispatchResult> | GantryDispatchResult;
  sendDm(input: GantryEmbeddedTeamsDmRequest): Promise<GantryDispatchResult> | GantryDispatchResult;
  sendThreadReply(input: GantryTeamsThreadReplyRequest): Promise<GantryDispatchResult> | GantryDispatchResult;
  handleIncomingActivity?(
    input: GantryTeamsIncomingActivityInput,
  ): Promise<GantryTeamsIncomingActivity> | GantryTeamsIncomingActivity;
  handleHttpActivity?(
    input: GantryTeamsHttpActivityInput,
  ): Promise<void> | void;
}

export interface GantryStructuredTaskRunner {
  runStructuredTask(input: GantryStructuredTaskInput): Promise<GantryStructuredTaskResult>;
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

export interface GantryRuntimeMessageRecord {
  readonly provider: "teams" | string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId?: string | null;
  readonly text?: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly occurredAt: string;
}

export interface GantryStructuredTaskAuditRecord {
  readonly taskRunId: string;
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly status: GantryStructuredTaskResult["status"];
  readonly input: Record<string, unknown>;
  readonly output?: Record<string, unknown> | null;
  readonly validationReport?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly occurredAt: string;
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
  readonly onActivity: (activity: GantryTeamsIncomingActivity) => Promise<void> | void;
}

export interface GantryTeamsIncomingActivity {
  readonly provider: "teams";
  readonly type: "message" | "invoke" | "unknown";
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

export interface GantryStructuredTaskInput {
  readonly taskType: string;
  readonly instructions: string;
  readonly input: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly correlationId?: string | null;
}

export interface GantryStructuredTaskResult {
  readonly status: "completed" | "needs_review" | "failed";
  readonly output: Record<string, unknown>;
  readonly validationReport?: Record<string, unknown> | null;
  readonly warnings?: readonly string[];
}

export interface GantryExternalNotificationCardRequest {
  readonly integrationId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly target: {
    readonly teamsChannelId: string;
    readonly workspaceId?: string | null;
    readonly workspaceName?: string | null;
  };
  readonly payload: Record<string, unknown>;
}

export interface GantryExternalPlatformEventRequest {
  readonly integrationId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
  readonly target?: Record<string, unknown>;
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

export interface GantryDispatchResult {
  readonly accepted: boolean;
  readonly statusCode: number;
  readonly body?: unknown;
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
    parameters: { readonly isGroup?: boolean; readonly members?: readonly unknown[] },
    logic: (context: TurnContext) => Promise<void>,
  ): Promise<void>;
}

export interface GantryPgRuntimeStorageConfig {
  readonly pool: {
    query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  readonly schema?: string;
}

export interface StructuredJsonModelProvider {
  generateJson(input: {
    readonly taskType: string;
    readonly instructions: string;
    readonly input: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly correlationId?: string | null;
  }): Promise<Record<string, unknown> | string>;
}

export interface StructuredBrowserToolProvider {
  runTask?(input: GantryStructuredTaskInput): Promise<Record<string, unknown>>;
  inspect?(input: GantryBrowserInspectInput): Promise<GantryBrowserInspectResult>;
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
  readonly blockedReason?: "login_required" | "captcha" | "robots" | "dead" | "parked" | "unsupported" | string | null;
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
  readonly blockedReason?: "login_required" | "captcha" | "dead" | "unsupported" | string | null;
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
  extract(input: GantryDocumentExtractInput): Promise<GantryDocumentExtractResult>;
}

export interface StructuredToolProviderSet {
  readonly search?: StructuredSearchToolProvider;
  readonly fetch?: StructuredFetchToolProvider;
  readonly crawl?: StructuredCrawlToolProvider;
  readonly browser?: StructuredBrowserToolProvider;
  readonly documentExtract?: StructuredDocumentExtractToolProvider;
}

export interface StructuredModelTaskRunnerConfig {
  readonly model: StructuredJsonModelProvider;
  readonly browser?: StructuredBrowserToolProvider;
  readonly tools?: StructuredToolProviderSet;
  readonly storage?: GantryRuntimeStorage;
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
}

export interface FirecrawlFetchProviderConfig {
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export function createTavilySearchProvider(config: TavilySearchProviderConfig): StructuredSearchToolProvider {
  if (!config.apiKey?.trim()) {
    throw new Error("TAVILY_API_KEY is required to create the Tavily search provider.");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey.trim();
  return {
    search: async (input) => {
      const maxResults = Math.min(input.limit ?? input.budget?.maxResults ?? config.maxResults ?? 5, config.maxResults ?? 10);
      const response = await fetchWithTimeout(
        fetchImpl,
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query: input.query,
            search_depth: "basic",
            include_answer: false,
            max_results: maxResults,
          }),
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 15_000,
      );
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Tavily search failed with HTTP ${response.status}.`);
      }
      const results = Array.isArray(payload.results) ? payload.results : [];
      return {
        provider: "tavily",
        items: results.flatMap((item) => {
          const record = asRecord(item);
          const url = asNonEmptyString(record?.url);
          if (!url) return [];
          return [{
            url,
            title: asNonEmptyString(record?.title),
            snippet: asNonEmptyString(record?.content) ?? asNonEmptyString(record?.snippet),
            source: "tavily",
          }];
        }).slice(0, maxResults),
      };
    },
  };
}

export function createFirecrawlSearchProvider(config: FirecrawlSearchProviderConfig): StructuredSearchToolProvider {
  if (!config.apiKey?.trim()) {
    throw new Error("FIRECRAWL_API_KEY is required to create the Firecrawl search provider.");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey.trim();
  return {
    search: async (input) => {
      const maxResults = Math.min(input.limit ?? input.budget?.maxResults ?? config.maxResults ?? 5, config.maxResults ?? 10);
      const response = await fetchWithTimeout(
        fetchImpl,
        "https://api.firecrawl.dev/v2/search",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: input.query,
            limit: maxResults,
            scrapeOptions: { formats: ["markdown"] },
          }),
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 20_000,
      );
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Firecrawl search failed with HTTP ${response.status}.`);
      }
      const results = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.results)
          ? payload.results
          : [];
      return {
        provider: "firecrawl-search",
        items: results.flatMap((item) => {
          const record = asRecord(item);
          const metadata = asRecord(record?.metadata);
          const url = asNonEmptyString(record?.url) ?? asNonEmptyString(metadata?.sourceURL);
          if (!url) return [];
          return [{
            url,
            title: asNonEmptyString(record?.title) ?? asNonEmptyString(metadata?.title),
            snippet: asNonEmptyString(record?.description)
              ?? asNonEmptyString(record?.markdown)
              ?? asNonEmptyString(record?.content),
            source: "firecrawl",
          }];
        }).slice(0, maxResults),
      };
    },
  };
}

export function createHttpFetchProvider(config: HttpFetchProviderConfig = {}): StructuredFetchToolProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    fetch: async (input) => {
      const maxBytes = input.budget?.maxBytes ?? config.maxBytes ?? 256_000;
      const response = await fetchWithTimeout(
        fetchImpl,
        input.url,
        {
          method: "GET",
          headers: {
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.3",
            "user-agent": "Agent.Gantry source discovery (+public procurement source validation)",
          },
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 12_000,
      );
      const contentType = response.headers.get("content-type");
      const text = trimToBudget(await response.text(), maxBytes);
      const isHtml = Boolean(contentType?.includes("html"));
      const readableText = isHtml ? htmlToReadableText(text) : text;
      return {
        url: response.url || input.url,
        statusCode: response.status,
        contentType,
        title: isHtml ? extractHtmlTitle(text) : null,
        text: trimToBudget(readableText, maxBytes),
        blockedReason: detectBlockedReason(response.status, contentType, readableText),
        provider: "http-fetch",
        warnings: text.length >= maxBytes ? [`Response truncated at ${maxBytes} bytes.`] : [],
      };
    },
  };
}

export function createFirecrawlFetchProvider(config: FirecrawlFetchProviderConfig): StructuredFetchToolProvider {
  if (!config.apiKey?.trim()) {
    throw new Error("FIRECRAWL_API_KEY is required to create the Firecrawl fetch provider.");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey.trim();
  return {
    fetch: async (input) => {
      const maxBytes = input.budget?.maxBytes ?? config.maxBytes ?? 256_000;
      const response = await fetchWithTimeout(
        fetchImpl,
        "https://api.firecrawl.dev/v2/scrape",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            url: input.url,
            formats: ["markdown", "html"],
          }),
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 20_000,
      );
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Firecrawl scrape failed with HTTP ${response.status}.`);
      }
      const data = asRecord(payload.data) ?? payload;
      const metadata = asRecord(data.metadata);
      const text = asNonEmptyString(data.markdown)
        ?? asNonEmptyString(data.content)
        ?? asNonEmptyString(data.html)
        ?? "";
      const trimmedText = trimToBudget(text, maxBytes);
      return {
        url: asNonEmptyString(metadata?.sourceURL) ?? asNonEmptyString(data.url) ?? input.url,
        statusCode: 200,
        contentType: "text/markdown",
        title: asNonEmptyString(metadata?.title) ?? asNonEmptyString(data.title),
        text: trimmedText,
        blockedReason: detectBlockedReason(200, "text/markdown", trimmedText),
        provider: "firecrawl-scrape",
        warnings: text.length >= maxBytes ? [`Response truncated at ${maxBytes} bytes.`] : [],
      };
    },
  };
}

export function createFirecrawlCrawlProvider(config: FirecrawlCrawlProviderConfig): StructuredCrawlToolProvider {
  if (!config.apiKey?.trim()) {
    throw new Error("FIRECRAWL_API_KEY is required to create the Firecrawl crawl provider.");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey.trim();
  return {
    crawl: async (input) => {
      const limit = Math.min(input.limit ?? input.budget?.maxPages ?? config.maxPages ?? 3, config.maxPages ?? 5);
      const response = await fetchWithTimeout(
        fetchImpl,
        "https://api.firecrawl.dev/v1/crawl",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            url: input.url,
            limit,
            scrapeOptions: { formats: ["markdown"] },
          }),
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 30_000,
      );
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Firecrawl crawl failed with HTTP ${response.status}.`);
      }
      const data = Array.isArray(payload.data) ? payload.data : [];
      return {
        startUrl: input.url,
        provider: "firecrawl",
        pages: data.flatMap((page) => {
          const record = asRecord(page);
          const metadata = asRecord(record?.metadata);
          const url = asNonEmptyString(metadata?.sourceURL) ?? asNonEmptyString(record?.url) ?? input.url;
          return [{
            url,
            title: asNonEmptyString(metadata?.title),
            text: asNonEmptyString(record?.markdown) ?? asNonEmptyString(record?.content),
            blockedReason: null,
          }];
        }).slice(0, limit),
      };
    },
  };
}

export function createHttpCrawlProvider(config: HttpFetchProviderConfig = {}): StructuredCrawlToolProvider {
  const fetchProvider = createHttpFetchProvider(config);
  return {
    crawl: async (input) => {
      const first = await fetchProvider.fetch(input);
      return {
        startUrl: input.url,
        provider: "http-crawl",
        warnings: first.warnings,
        pages: [{
          url: first.url,
          title: first.title,
          text: first.text,
          blockedReason: first.blockedReason,
        }],
      };
    },
  };
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

export interface GantryExternalCardAction {
  readonly integrationId: string;
  readonly eventId: string;
  readonly resourceId: string;
  readonly workspaceId: string;
  readonly sourceWorkspaceId?: string | null;
  readonly sourceChannelId: string;
  readonly teamsTenantId: string;
  readonly actionType: string;
  readonly platformOperation: string;
  readonly requestId?: string | null;
  readonly signatureVersion?: "v2" | null;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export interface GantryExternalCardActionSigningInput {
  readonly integrationId: string;
  readonly eventId: string;
  readonly resourceId: string | null;
  readonly workspaceId: string | null;
  readonly sourceChannelId: string | null;
  readonly teamsTenantId: string | null;
  readonly actionType: string;
  readonly platformOperation?: string | null;
  readonly requestId?: string | null;
  readonly signatureVersion?: "v2" | null;
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

export class GantryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly eventSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GantryClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey?.trim() ?? "";
    this.eventSecret = config.eventSecret?.trim() ?? "";
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  readonly notifications = {
    sendCard: async (input: GantryExternalNotificationCardRequest): Promise<GantryDispatchResult> => {
      return await this.sendExternalNotificationCard(input);
    },
    sendEvent: async (input: GantryExternalPlatformEventRequest): Promise<GantryDispatchResult> => {
      return await this.sendExternalPlatformEvent(input);
    },
  };

  readonly teams = {
    sendThreadReply: async (input: GantryTeamsThreadReplyRequest): Promise<GantryDispatchResult> => {
      return await this.sendTeamsThreadReply(input);
    },
    getConversationReferenceStatus: async (
      conversationId: string,
    ): Promise<GantryTeamsConversationReferenceStatus> => {
      return await this.getTeamsConversationReferenceStatus(conversationId);
    },
  };

  async sendExternalNotificationCard(
    input: GantryExternalNotificationCardRequest,
  ): Promise<GantryDispatchResult> {
    return await this.sendExternalPlatformEvent({
      integrationId: input.integrationId,
      eventId: input.eventId,
      eventType: "notification.card.requested",
      occurredAt: input.occurredAt,
      target: {
        teamsChannelId: requireNonEmpty(input.target.teamsChannelId, "target.teamsChannelId"),
        workspaceId: input.target.workspaceId ?? null,
        workspaceName: input.target.workspaceName ?? null,
      },
      payload: input.payload,
    });
  }

  async sendExternalPlatformEvent(
    input: GantryExternalPlatformEventRequest,
  ): Promise<GantryDispatchResult> {
    if (!this.eventSecret) {
      throw new Error("Gantry eventSecret is required to send external platform events.");
    }

    const path = "/v1/integrations/platform-events";
    const body = {
      integrationId: requireNonEmpty(input.integrationId, "integrationId"),
      eventId: requireNonEmpty(input.eventId, "eventId"),
      eventType: requireNonEmpty(input.eventType, "eventType"),
      occurredAt: requireNonEmpty(input.occurredAt, "occurredAt"),
      ...(input.target ? { target: input.target } : {}),
      payload: input.payload,
    };
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const signature = signExternalEventRequest({
      secret: this.eventSecret,
      method: "POST",
      path,
      timestamp,
      nonce,
      rawBody,
    });

    return await this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gantry-external-event-timestamp": timestamp,
        "x-gantry-external-event-nonce": nonce,
        "x-gantry-external-event-signature": signature,
      },
      body: rawBody,
    });
  }

  async sendTeamsThreadReply(input: GantryTeamsThreadReplyRequest): Promise<GantryDispatchResult> {
    this.requireApiKey("send Teams thread replies");
    const path = input.path?.trim() || "/v1/providers/teams/thread-replies";
    return await this.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        conversationId: requireNonEmpty(input.conversationId, "conversationId"),
        replyToId: requireNonEmpty(input.replyToId, "replyToId"),
        text: requireNonEmpty(input.text, "text"),
      }),
    });
  }

  async getTeamsConversationReferenceStatus(
    conversationId: string,
  ): Promise<GantryTeamsConversationReferenceStatus> {
    this.requireApiKey("read Teams conversation readiness");
    const normalized = conversationId.trim();
    if (!normalized) {
      return { exists: false, conversationId };
    }

    const response = await this.rawRequest(
      `/v1/providers/teams/conversation-references/${encodeURIComponent(normalized)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
        },
      },
    );
    if (response.status === 404) {
      return { exists: false, conversationId: normalized };
    }
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw gantryHttpError("Gantry Teams readiness check failed", response.status, body);
    }
    const payload = asRecord(body);
    return {
      exists: payload?.exists === true,
      conversationId: readString(payload, "conversationId") ?? normalized,
      conversationJid: readString(payload, "conversationJid"),
      tenantId: readString(payload, "tenantId"),
      botId: readString(payload, "botId"),
      updatedAt: readString(payload, "updatedAt"),
    };
  }

  private async request(path: string, init: RequestInit): Promise<GantryDispatchResult> {
    const response = await this.rawRequest(path, init);
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw gantryHttpError("Gantry request failed", response.status, body);
    }
    return {
      accepted: true,
      statusCode: response.status,
      body,
    };
  }

  private async rawRequest(path: string, init: RequestInit): Promise<Response> {
    return await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private requireApiKey(action: string): void {
    if (!this.apiKey) {
      throw new Error(`Gantry apiKey is required to ${action}.`);
    }
  }
}

export class GantryRuntime {
  constructor(private readonly config: GantryRuntimeConfig = {}) {}

  readonly teams = {
    sendCard: async (input: GantryEmbeddedTeamsCardRequest): Promise<GantryDispatchResult> => {
      const transport = this.requireTeamsTransport("send Teams cards");
      return await transport.sendCard(input);
    },
    sendDm: async (input: GantryEmbeddedTeamsDmRequest): Promise<GantryDispatchResult> => {
      const transport = this.requireTeamsTransport("send Teams DMs");
      return await transport.sendDm(input);
    },
    sendThreadReply: async (input: GantryTeamsThreadReplyRequest): Promise<GantryDispatchResult> => {
      const transport = this.requireTeamsTransport("send Teams thread replies");
      return await transport.sendThreadReply(input);
    },
    handleIncomingActivity: async (
      input: GantryTeamsIncomingActivityInput,
    ): Promise<GantryTeamsIncomingActivity> => {
      const parsed = this.config.teams?.handleIncomingActivity
        ? await this.config.teams.handleIncomingActivity(input)
        : parseTeamsIncomingActivity(input.activity);
      await this.conversations.recordMessage({
        provider: "teams",
        conversationId: parsed.conversationId,
        messageId: parsed.messageId,
        senderId: parsed.teamsUserId ?? null,
        text: parsed.text ?? null,
        payload: parsed.raw,
        occurredAt: new Date().toISOString(),
      });
      return parsed;
    },
    handleHttpActivity: async (input: GantryTeamsHttpActivityInput): Promise<void> => {
      const transport = this.requireTeamsTransport("handle Teams HTTP activities");
      if (!transport.handleHttpActivity) {
        throw new Error("Gantry Teams transport does not support HTTP activity handling.");
      }
      await transport.handleHttpActivity({
        ...input,
        onActivity: async (activity) => {
          await this.conversations.recordMessage({
            provider: "teams",
            conversationId: activity.conversationId,
            messageId: activity.messageId,
            senderId: activity.teamsUserId ?? null,
            text: activity.text ?? null,
            payload: activity.raw,
            occurredAt: new Date().toISOString(),
          });
          await input.onActivity(activity);
        },
      });
    },
    getConversationReferenceStatus: async (
      conversationId: string,
    ): Promise<GantryTeamsConversationReferenceStatus> => {
      const normalized = conversationId.trim();
      const stored = await this.config.storage?.getTeamsConversationReference?.(normalized);
      return stored ?? { exists: false, conversationId: normalized };
    },
  };

  readonly tasks = {
    runStructuredTask: async (input: GantryStructuredTaskInput): Promise<GantryStructuredTaskResult> => {
      if (!this.config.tasks) {
        throw new Error("Gantry structured task runner is not configured.");
      }
      return await this.config.tasks.runStructuredTask(input);
    },
  };

  readonly signing = {
    verifyTeamsRequest: (input: Omit<GantrySignatureVerificationInput, "secret"> & { readonly secret?: string }): boolean => {
      const secret = input.secret ?? this.config.signing?.teamsRequestSecret ?? "";
      if (!secret) {
        throw new Error("Gantry Teams request signing secret is not configured.");
      }
      return verifyExternalEventSignature({ ...input, secret });
    },
    signInternalEvent: (input: Omit<GantrySignatureInput, "secret"> & { readonly secret?: string }): string => {
      const secret = input.secret ?? this.config.signing?.internalEventSecret ?? "";
      if (!secret) {
        throw new Error("Gantry internal event signing secret is not configured.");
      }
      return signExternalEventRequest({ ...input, secret });
    },
  };

  readonly conversations = {
    recordMessage: async (input: GantryRuntimeMessageRecord): Promise<void> => {
      await this.config.storage?.recordMessage?.(input);
    },
  };

  private requireTeamsTransport(action: string): GantryTeamsTransport {
    if (!this.config.teams) {
      throw new Error(`Gantry Teams transport is required to ${action}.`);
    }
    return this.config.teams;
  }
}

export function createGantryRuntime(config: GantryRuntimeConfig = {}): GantryRuntime {
  return new GantryRuntime(config);
}

export function createBotFrameworkTeamsTransport(
  config: GantryBotFrameworkTeamsTransportConfig,
): GantryTeamsTransport {
  const adapter = config.adapter ?? new BotFrameworkAdapter({
    appId: requireNonEmpty(config.botAppId, "botAppId"),
    appPassword: requireNonEmpty(config.botAppPassword, "botAppPassword"),
    channelAuthTenant: config.botTenantId?.trim() || undefined,
  });

  async function sendToConversation(
    conversationId: string,
    send: (context: TurnContext) => Promise<ResourceResponse | undefined>,
    referenceConversationId = conversationId,
  ): Promise<GantryDispatchResult> {
    const reference = await readConversationReference(config.storage, referenceConversationId);
    let response: ResourceResponse | undefined;
    await adapter.continueConversation(parseStoredReference(reference, conversationId), async (context) => {
      response = await send(context);
    });
    return { accepted: true, statusCode: 202, body: response ?? null };
  }

  return {
    sendCard: async (input) => await sendToConversation(input.conversationId, async (context) => {
      return await context.sendActivity({
        type: ActivityTypes.Message,
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          content: input.card,
        }],
      });
    }),
    sendDm: async (input) => {
      const reference = await config.storage.getTeamsPersonalConversationReference?.({
        teamsUserId: input.teamsUserId,
        teamsTenantId: input.teamsTenantId,
      });
      if (!reference?.rawReferenceJson) {
        return {
          accepted: false,
          statusCode: 409,
          body: { code: "teams_personal_conversation_reference_missing" },
        };
      }
      let response: ResourceResponse | undefined;
      const storedReference = parseStoredReference(reference, reference.conversationId);
      const sendActivity = async (context: TurnContext) => {
        response = await context.sendActivity(input.card
          ? {
              type: ActivityTypes.Message,
              text: input.text ?? undefined,
              attachments: [{
                contentType: "application/vnd.microsoft.card.adaptive",
                content: input.card,
              }],
            }
          : { type: ActivityTypes.Message, text: input.text ?? "" });
      };
      if (isPersonalTeamsConversationReference(storedReference)) {
        await adapter.continueConversation(storedReference, sendActivity);
      } else {
        const createConversation = adapter.createConversation?.bind(adapter);
        if (!createConversation) {
          return {
            accepted: false,
            statusCode: 409,
            body: { code: "teams_personal_conversation_reference_missing" },
          };
        }
        await createConversation(storedReference, {
          isGroup: false,
          members: storedReference.user ? [storedReference.user] : undefined,
        }, sendActivity);
      }
      return { accepted: true, statusCode: 202, body: response ?? null };
    },
    sendThreadReply: async (input) => await sendToConversation(
      teamsThreadConversationId(input.conversationId, input.replyToId),
      async (context) => await context.sendActivity({
        type: ActivityTypes.Message,
        text: input.text,
        replyToId: input.replyToId,
      }),
      teamsBaseConversationIdFromThreadConversationId(input.conversationId),
    ),
    handleIncomingActivity: (input) => parseTeamsIncomingActivity(input.activity),
    handleHttpActivity: async (input) => {
      await adapter.processActivity(input.req, createBotFrameworkResponse(input.res), async (context) => {
        const activity = parseBotFrameworkActivity(context.activity);
        await rememberTeamsConversationReference(config.storage, context.activity);
        await input.onActivity(activity);
        if (context.activity.type === ActivityTypes.Invoke) {
          await context.sendActivity({
            type: ActivityTypes.InvokeResponse,
            value: {
              status: 200,
              body: "Action received.",
            },
          });
        }
      });
    },
  };
}

export function createPgGantryRuntimeStorage(
  config: GantryPgRuntimeStorageConfig,
): GantryRuntimeStorage {
  const schema = normalizeSqlIdentifier(config.schema ?? "gantry_runtime");
  return {
    recordMessage: async (input) => {
      await config.pool.query(
        `insert into "${schema}"."runtime_messages" (provider, conversation_id, message_id, sender_id, text, payload_json, occurred_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
         on conflict (provider, message_id) do nothing`,
        [
          input.provider,
          input.conversationId,
          input.messageId,
          input.senderId ?? null,
          input.text ?? null,
          JSON.stringify(input.payload ?? {}),
          input.occurredAt,
        ],
      );
    },
    recordStructuredTaskRun: async (input) => {
      await config.pool.query(
        `insert into "${schema}"."structured_task_runs" (task_run_id, task_type, correlation_id, status, input_json, output_json, validation_report_json, error, occurred_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
         on conflict (task_run_id) do nothing`,
        [
          input.taskRunId,
          input.taskType,
          input.correlationId ?? null,
          input.status,
          JSON.stringify(input.input),
          JSON.stringify(input.output ?? {}),
          JSON.stringify(input.validationReport ?? {}),
          input.error ?? null,
          input.occurredAt,
        ],
      );
    },
    getTeamsConversationReference: async (conversationId) => {
      const normalized = normalizeTeamsJid(conversationId);
      const result = await config.pool.query(
        `select conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at
         from "${schema}"."teams_conversation_references"
         where conversation_jid = $1 or conversation_id = $2
         limit 1`,
        [normalized, conversationId],
      );
      return mapTeamsReferenceRow(result.rows[0], conversationId);
    },
    getTeamsPersonalConversationReference: async (input) => {
      const result = await config.pool.query(
        `select conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at
         from "${schema}"."teams_conversation_references"
         where teams_user_id = $1 and ($2::text is null or tenant_id = $2)
         order by updated_at desc
         limit 1`,
        [input.teamsUserId, input.teamsTenantId ?? null],
      );
      return mapTeamsReferenceRow(result.rows[0], input.teamsUserId);
    },
    saveTeamsConversationReference: async (reference) => {
      await config.pool.query(
        `insert into "${schema}"."teams_conversation_references" (conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
         on conflict (conversation_jid) do update set
           conversation_id = excluded.conversation_id,
           service_url = excluded.service_url,
           tenant_id = excluded.tenant_id,
           bot_id = excluded.bot_id,
           teams_user_id = excluded.teams_user_id,
           raw_reference_json = excluded.raw_reference_json,
           updated_at = excluded.updated_at`,
        [
          reference.conversationJid ?? normalizeTeamsJid(reference.conversationId),
          reference.conversationId,
          reference.serviceUrl ?? null,
          reference.tenantId ?? null,
          reference.botId ?? null,
          reference.teamsUserId ?? null,
          reference.rawReferenceJson ?? null,
          reference.updatedAt ?? null,
        ],
      );
    },
  };
}

export function createStructuredModelTaskRunner(
  config: StructuredModelTaskRunnerConfig,
): GantryStructuredTaskRunner {
  return {
    runStructuredTask: async (input) => {
      const taskRunId = input.correlationId ?? randomUUID();
      try {
        const tools = config.tools ?? { browser: config.browser };
        const browserContext = await (tools.browser ?? config.browser)?.runTask?.(input);
        const toolContext = await collectStructuredToolContext(tools, input);
        const generated = await config.model.generateJson({
          ...input,
          input: {
            ...input.input,
            ...(browserContext ? { browserContext } : {}),
            ...(toolContext ? { toolContext } : {}),
          },
        });
        const modelOutput = typeof generated === "string" ? parseJsonRecord(generated) : generated;
        const output = toolContext ? { ...modelOutput, toolContext } : modelOutput;
        const status = output.status === "needs_review" || output.status === "failed"
          ? output.status
          : "completed";
        const result: GantryStructuredTaskResult = {
          status,
          output,
          validationReport: asRecord(output.validationReportJson) ?? { status },
          warnings: Array.isArray(output.warnings) ? output.warnings.filter((value): value is string => typeof value === "string") : [],
        };
        await config.storage?.recordStructuredTaskRun?.({
          taskRunId,
          taskType: input.taskType,
          correlationId: input.correlationId,
          status: result.status,
          input: input.input,
          output: result.output,
          validationReport: result.validationReport,
          occurredAt: new Date().toISOString(),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await config.storage?.recordStructuredTaskRun?.({
          taskRunId,
          taskType: input.taskType,
          correlationId: input.correlationId,
          status: "failed",
          input: input.input,
          error: message,
          occurredAt: new Date().toISOString(),
        });
        return {
          status: "failed",
          output: { error: message },
          validationReport: { status: "failed", error: message },
          warnings: [message],
        };
      }
    },
  };
}

async function collectStructuredToolContext(
  tools: StructuredToolProviderSet,
  input: GantryStructuredTaskInput,
): Promise<Record<string, unknown> | null> {
  const toolRequests = asRecord(input.input.toolRequests);
  if (!toolRequests) {
    return null;
  }

  const context: Record<string, unknown> = {};
  const searchRequests = Array.isArray(toolRequests.search) ? toolRequests.search : [];
  if (tools.search && searchRequests.length > 0) {
    const searchTool = tools.search;
    context.search = await Promise.all(searchRequests.map(async (request) => {
      const record = asRecord(request) ?? {};
      const query = readString(record, "query") ?? "";
      if (!query.trim()) return { error: "search_query_required" };
      const result = await searchTool.search({
        query,
        limit: readNumber(record, "limit") ?? undefined,
        budget: asRecord(record.budget) ?? undefined,
        correlationId: input.correlationId ?? null,
      });
      return { query, ...result };
    }));
  }

  const fetchRequests = Array.isArray(toolRequests.fetch) ? toolRequests.fetch : [];
  if (tools.fetch && fetchRequests.length > 0) {
    const fetchTool = tools.fetch;
    context.fetch = await Promise.all(fetchRequests.map(async (request) => {
      const record = asRecord(request) ?? {};
      const url = readString(record, "url") ?? "";
      if (!url.trim()) return { error: "fetch_url_required" };
      const result = await fetchTool.fetch({
        url,
        budget: asRecord(record.budget) ?? undefined,
        correlationId: input.correlationId ?? null,
      });
      return { requestedUrl: url, ...result };
    }));
  }

  const crawlRequests = Array.isArray(toolRequests.crawl) ? toolRequests.crawl : [];
  if (tools.crawl && crawlRequests.length > 0) {
    context.crawl = await Promise.all(crawlRequests.map(async (request) => {
      const record = asRecord(request) ?? {};
      const url = readString(record, "url") ?? "";
      if (!url.trim()) return { error: "crawl_url_required" };
      return await tools.crawl?.crawl({
        url,
        limit: readNumber(record, "limit") ?? undefined,
        budget: asRecord(record.budget) ?? undefined,
        correlationId: input.correlationId ?? null,
      });
    }));
  }

  const browserRequests = Array.isArray(toolRequests.browserInspect) ? toolRequests.browserInspect : [];
  if (tools.browser?.inspect && browserRequests.length > 0) {
    context.browserInspect = await Promise.all(browserRequests.map(async (request) => {
      const record = asRecord(request) ?? {};
      const url = readString(record, "url") ?? "";
      if (!url.trim()) return { error: "browser_url_required" };
      return await tools.browser?.inspect?.({
        url,
        instructions: readString(record, "instructions"),
        budget: asRecord(record.budget) ?? undefined,
        correlationId: input.correlationId ?? null,
      });
    }));
  }

  const documentRequests = Array.isArray(toolRequests.documentExtract) ? toolRequests.documentExtract : [];
  if (tools.documentExtract && documentRequests.length > 0) {
    context.documentExtract = await Promise.all(documentRequests.map(async (request) => {
      const record = asRecord(request) ?? {};
      return await tools.documentExtract?.extract({
        url: readString(record, "url"),
        contentType: readString(record, "contentType"),
        text: readString(record, "text"),
        budget: asRecord(record.budget) ?? undefined,
        correlationId: input.correlationId ?? null,
      });
    }));
  }

  return Object.keys(context).length > 0 ? context : null;
}

export function createGantryClient(config: GantryClientConfig): GantryClient {
  return new GantryClient(config);
}

export async function sendExternalNotificationCard(
  config: GantryClientConfig,
  input: GantryExternalNotificationCardRequest,
): Promise<GantryDispatchResult> {
  return await createGantryClient(config).sendExternalNotificationCard(input);
}

export async function sendExternalPlatformEvent(
  config: GantryClientConfig,
  input: GantryExternalPlatformEventRequest,
): Promise<GantryDispatchResult> {
  return await createGantryClient(config).sendExternalPlatformEvent(input);
}

export async function sendTeamsThreadReply(
  config: GantryClientConfig,
  input: GantryTeamsThreadReplyRequest,
): Promise<GantryDispatchResult> {
  return await createGantryClient(config).sendTeamsThreadReply(input);
}

export async function getTeamsConversationReferenceStatus(
  config: GantryClientConfig,
  conversationId: string,
): Promise<GantryTeamsConversationReferenceStatus> {
  return await createGantryClient(config).getTeamsConversationReferenceStatus(conversationId);
}

export function signExternalEventRequest(input: GantrySignatureInput): string {
  return createHmac("sha256", input.secret)
    .update(buildExternalSignaturePayload(input))
    .digest("hex");
}

export function verifyExternalEventSignature(input: GantrySignatureVerificationInput): boolean {
  const timestampMs = Number(input.timestamp);
  const toleranceMs = input.toleranceMs ?? 5 * 60_000;
  if (
    !Number.isFinite(timestampMs) ||
    (toleranceMs >= 0 && Math.abs((input.nowMs ?? Date.now()) - timestampMs) > toleranceMs)
  ) {
    return false;
  }
  return timingSafeHexEqual(signExternalEventRequest(input), input.signature);
}

export function verifyWebhookSignature(input: GantryWebhookSignatureVerificationInput): boolean {
  const timestampMs = Number(input.timestamp);
  const toleranceMs = input.toleranceMs ?? 5 * 60_000;
  if (
    !Number.isFinite(timestampMs) ||
    (toleranceMs >= 0 && Math.abs((input.nowMs ?? Date.now()) - timestampMs) > toleranceMs)
  ) {
    return false;
  }
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.eventId}.${input.eventType}.${input.rawBody}`)
    .digest("hex");
  return timingSafeHexEqual(expected, input.signature);
}

export function signExternalCardAction(input: GantryExternalCardActionSigningInput & { readonly secret: string }): {
  readonly nonce: string;
  readonly expiresAt: string;
  readonly signature: string;
  readonly signatureVersion?: "v2";
} {
  const nonce = input.nonce ?? randomUUID();
  const expiresAt = input.expiresAt ?? new Date((input.nowMs ?? Date.now()) + 24 * 60 * 60_000).toISOString();
  return {
    nonce,
    expiresAt,
    ...(input.signatureVersion === "v2" ? { signatureVersion: "v2" as const } : {}),
    signature: createHmac("sha256", input.secret)
      .update(stableCardActionPayload({ ...input, nonce, expiresAt }))
      .digest("hex"),
  };
}

export function verifyExternalCardAction(input: GantryExternalCardActionVerificationInput): boolean {
  const expiresAtMs = Date.parse(input.action.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < (input.nowMs ?? Date.now())) {
    return false;
  }
  const expected = signExternalCardAction({
    secret: input.secret,
    integrationId: input.action.integrationId,
    eventId: input.action.eventId,
    resourceId: input.action.resourceId,
    workspaceId: input.action.workspaceId,
    sourceChannelId: input.action.sourceChannelId,
    teamsTenantId: input.action.teamsTenantId,
    actionType: input.action.actionType,
    platformOperation: input.action.signatureVersion === "v2" ? input.action.platformOperation : null,
    requestId: input.action.signatureVersion === "v2" ? input.action.requestId ?? null : null,
    signatureVersion: input.action.signatureVersion ?? null,
    nonce: input.action.nonce,
    expiresAt: input.action.expiresAt,
    nowMs: input.nowMs,
  }).signature;
  return timingSafeHexEqual(expected, input.action.signature);
}

export function parseExternalCardAction(value: unknown): GantryExternalCardAction | null {
  if (!value || typeof value !== "object") return null;
  const record = unwrapExternalCardActionValue(value as Record<string, unknown>);
  if (!record || record.action !== "external_card_action") return null;
  const action = {
    integrationId: readStringValue(record.integrationId),
    eventId: readStringValue(record.eventId),
    resourceId: readStringValue(record.resourceId),
    workspaceId: readStringValue(record.workspaceId),
    sourceWorkspaceId: readStringValue(record.sourceWorkspaceId),
    sourceChannelId: readStringValue(record.sourceChannelId),
    teamsTenantId: readStringValue(record.teamsTenantId),
    actionType: readStringValue(record.actionType),
    platformOperation: readStringValue(record.platformOperation),
    requestId: readStringValue(record.requestId),
    signatureVersion: readStringValue(record.signatureVersion) === "v2" ? "v2" as const : null,
    nonce: readStringValue(record.nonce),
    expiresAt: readStringValue(record.expiresAt),
    signature: readStringValue(record.signature),
  };
  if (
    !action.integrationId ||
    !action.eventId ||
    !action.resourceId ||
    !action.workspaceId ||
    !action.sourceChannelId ||
    !action.teamsTenantId ||
    !action.actionType ||
    !action.platformOperation ||
    !action.nonce ||
    !action.expiresAt ||
    !action.signature
  ) {
    return null;
  }
  return action;
}

export function buildExternalNotificationAdaptiveCard(
  input: GantryExternalNotificationAdaptiveCardInput,
): Record<string, unknown> | null {
  const card = readNotificationCard(input.payload.notificationCard);
  if (!card) return null;
  const resourceId = readOptionalString(card.resourceId) ?? readOptionalString(input.payload.resourceId);
  const facts = [
    adaptiveFact("Tender ID", resourceId),
    adaptiveFact("EMD", formatNotificationAmount(card.emd, card.currency)),
    adaptiveFact("Workspace matched", card.workspace?.workspaceName),
    adaptiveFact("Organisation Details", card.organization),
    adaptiveFact("Location Details", card.location),
    adaptiveFact("Dead Line Date", card.deadline),
    adaptiveFact("Published Date", card.publishedDate),
  ].filter((entry): entry is { title: string; value: string } => Boolean(entry));
  const summary = sanitizeNotificationSummary(card.summary ?? null);
  const body: Record<string, unknown>[] = [
    { type: "TextBlock", size: "Medium", weight: "Bolder", text: card.title, wrap: true },
    ...(summary ? [{ type: "TextBlock", text: summary, wrap: true }] : []),
    ...(facts.length ? [{ type: "FactSet", facts }] : []),
    ...buildDocumentLinkBlocks(card),
  ];

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.2",
    body,
    actions: readNotificationActions(card.actions)
      .filter((action) => action.presentation === "submit")
      .map((action) => buildTeamsSubmitAction(input, card, action, resourceId))
      .filter((action): action is Record<string, unknown> => Boolean(action)),
  };
}

export const signGantryExternalEventRequest = signExternalEventRequest;
export const verifyGantryExternalEventSignature = verifyExternalEventSignature;

function buildExternalSignaturePayload(input: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly rawBody: string;
}): string {
  return [
    input.method.trim().toUpperCase(),
    input.path.trim(),
    input.timestamp.trim(),
    input.nonce.trim(),
    input.rawBody,
  ].join("\n");
}

function timingSafeHexEqual(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex);
  const right = Buffer.from(rightHex);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (typeof response.text !== "function") {
    const responseWithJson = response as Response & { readonly json?: () => Promise<unknown> };
    return typeof responseWithJson.json === "function" ? await responseWithJson.json() : null;
  }
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function gantryHttpError(message: string, statusCode: number, body: unknown): Error {
  const suffix = typeof body === "string" && body.trim() ? `: ${body}` : "";
  const error = new Error(`${message} (${statusCode})${suffix}`);
  Object.assign(error, { statusCode, body });
  return error;
}

function requireNonEmpty(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function trimToBudget(text: string, maxBytes: number): string {
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function htmlToReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function detectBlockedReason(statusCode: number, contentType: string | null, text: string): GantryFetchToolResult["blockedReason"] {
  const normalized = text.toLowerCase();
  if (statusCode === 404 || statusCode === 410) return "dead";
  if (statusCode >= 400) return "unsupported";
  if (contentType && !contentType.includes("html") && !contentType.includes("text") && !contentType.includes("json")) return "unsupported";
  if (normalized.includes("captcha") || normalized.includes("cloudflare ray id")) return "captcha";
  if (normalized.includes("login required") || normalized.includes("sign in") || normalized.includes("please login")) return "login_required";
  if (normalized.includes("domain for sale") || normalized.includes("buy this domain") || normalized.includes("parked free")) return "parked";
  return null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readOptionalNumberOrString(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return readOptionalString(value);
}

function unwrapExternalCardActionValue(record: Record<string, unknown>): Record<string, unknown> | null {
  if (record.action === "external_card_action") return record;
  const action = record.action;
  if (action && typeof action === "object") {
    const actionRecord = action as Record<string, unknown>;
    if (actionRecord.data && typeof actionRecord.data === "object") {
      return actionRecord.data as Record<string, unknown>;
    }
  }
  if (record.data && typeof record.data === "object") {
    return record.data as Record<string, unknown>;
  }
  return null;
}

function stableCardActionPayload(input: {
  readonly integrationId: string;
  readonly eventId: string;
  readonly resourceId: string | null;
  readonly workspaceId: string | null;
  readonly sourceChannelId: string | null;
  readonly teamsTenantId: string | null;
  readonly actionType: string;
  readonly platformOperation?: string | null;
  readonly requestId?: string | null;
  readonly signatureVersion?: "v2" | null;
  readonly nonce: string;
  readonly expiresAt: string;
}): string {
  const payload: Record<string, unknown> = {
    integrationId: input.integrationId,
    eventId: input.eventId,
    resourceId: input.resourceId,
    workspaceId: input.workspaceId,
    sourceChannelId: input.sourceChannelId,
    teamsTenantId: input.teamsTenantId,
    actionType: input.actionType,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
  };
  if (input.signatureVersion === "v2") {
    payload.signatureVersion = "v2";
    payload.platformOperation = input.platformOperation ?? null;
    payload.requestId = input.requestId ?? null;
  }
  return JSON.stringify(Object.fromEntries(Object.entries(payload).sort()));
}

type NotificationCardAction = {
  readonly actionType: string;
  readonly label: string;
  readonly presentation: string;
  readonly url?: string | null;
  readonly platformOperation?: string | null;
};

type NotificationCard = {
  readonly title: string;
  readonly resourceId?: string | null;
  readonly organization?: string | null;
  readonly location?: string | null;
  readonly deadline?: string | null;
  readonly publishedDate?: string | null;
  readonly emd?: number | string | null;
  readonly currency?: string | null;
  readonly summary?: string | null;
  readonly workspace?: {
    readonly workspaceId?: string | null;
    readonly workspaceName?: string | null;
    readonly teamsChannelId?: string | null;
    readonly teamsTenantId?: string | null;
  };
  readonly documents?: unknown;
  readonly actions?: unknown;
};

function readNotificationCard(value: unknown): NotificationCard | null {
  if (!value || typeof value !== "object") return null;
  const card = value as Record<string, unknown>;
  if (
    card.schemaVersion !== "external.notification.card.v1" ||
    card.renderer !== "gantry_adaptive_card" ||
    !readOptionalString(card.title)
  ) {
    return null;
  }
  return {
    title: readOptionalString(card.title) ?? "New notification",
    resourceId: readOptionalString(card.resourceId),
    organization: readOptionalString(card.organization),
    location: readOptionalString(card.location),
    deadline: readOptionalString(card.deadline),
    publishedDate: readOptionalString(card.publishedDate),
    emd: readOptionalNumberOrString(card.emd),
    currency: readOptionalString(card.currency),
    summary: readOptionalString(card.summary),
    workspace: card.workspace && typeof card.workspace === "object"
      ? card.workspace as NotificationCard["workspace"]
      : undefined,
    documents: Array.isArray(card.documents) ? card.documents : [],
    actions: card.actions,
  };
}

function readNotificationActions(value: unknown): NotificationCardAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const action = entry as Record<string, unknown>;
    const actionType = readOptionalString(action.actionType);
    const label = readOptionalString(action.label);
    const presentation = readOptionalString(action.presentation);
    if (!actionType || !label || !presentation) return [];
    return [{
      actionType,
      label,
      presentation,
      url: readOptionalString(action.url),
      platformOperation: readOptionalString(action.platformOperation),
    }];
  });
}

function buildTeamsSubmitAction(
  input: GantryExternalNotificationAdaptiveCardInput,
  card: NotificationCard,
  action: NotificationCardAction,
  resourceId: string | null,
): Record<string, unknown> | null {
  const platformOperation = readOptionalString(action.platformOperation);
  const workspaceId = readOptionalString(card.workspace?.workspaceId);
  const sourceChannelId = readOptionalString(card.workspace?.teamsChannelId);
  const teamsTenantId = readOptionalString(card.workspace?.teamsTenantId) ?? readOptionalString(input.target?.teamsTenantId);
  if (!platformOperation || !resourceId || !workspaceId || !sourceChannelId || !teamsTenantId) {
    return null;
  }
  return {
    type: "Action.Submit",
    title: action.label,
    data: {
      action: "external_card_action",
      actionType: action.actionType,
      platformOperation,
      integrationId: input.integrationId,
      eventId: input.eventId,
      resourceId,
      workspaceId,
      sourceWorkspaceId: workspaceId,
      sourceChannelId,
      teamsTenantId,
      ...signExternalCardAction({
        secret: input.actionSecret,
        integrationId: input.integrationId,
        eventId: input.eventId,
        resourceId,
        workspaceId,
        sourceChannelId,
        teamsTenantId,
        actionType: action.actionType,
        nowMs: input.nowMs,
      }),
    },
  };
}

function buildDocumentLinkBlocks(card: NotificationCard): Record<string, unknown>[] {
  if (!Array.isArray(card.documents)) return [];
  const links = card.documents
    .flatMap((entry, index): string[] => {
      if (!entry || typeof entry !== "object") return [];
      const document = entry as Record<string, unknown>;
      const url = normalizeHttpUrl(document.signedDownloadUrl);
      if (!url) return [];
      const label = readOptionalString(document.documentLabel) ?? readOptionalString(document.fileName) ?? `Document ${index + 1}`;
      return [`[${escapeMarkdownLinkLabel(label)}](${escapeMarkdownLinkUrl(url)})`];
    })
    .slice(0, 5);
  if (links.length === 0) return [];
  return [
    { type: "TextBlock", text: "Documents", weight: "Bolder", wrap: true, spacing: "Medium" },
    { type: "TextBlock", text: links.join("\n"), wrap: true, spacing: "Small" },
  ];
}

function adaptiveFact(title: string, value: string | null | undefined): { title: string; value: string } | null {
  const normalized = readOptionalString(value);
  return normalized ? { title, value: normalized } : null;
}

function formatNotificationAmount(amount: number | string | null | undefined, currency: string | null | undefined): string | null {
  if (amount === null || amount === undefined || amount === "") return null;
  return typeof amount === "number" ? `${currency || "INR"} ${amount.toLocaleString("en-IN")}` : amount;
}

function normalizeHttpUrl(value: unknown): string | null {
  const raw = readOptionalString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/([\\[\]()])/g, "\\$1");
}

function escapeMarkdownLinkUrl(value: string): string {
  return value.replace(/[()]/g, (character) => character === "(" ? "%28" : "%29");
}

function sanitizeNotificationSummary(value: string | null): string | null {
  const lines = value
    ?.split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !notificationSummaryNoisePatterns.some((pattern) => pattern.test(line))) ?? [];
  const summary = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!summary || summary.length < 12) return null;
  return summary.length > 420 ? `${summary.slice(0, 417).trimEnd()}...` : summary;
}

const notificationSummaryNoisePatterns = [
  /^screen reader access$/i,
  /^search\s*\|/i,
  /active tenders/i,
  /corrigendum/i,
  /results of tenders/i,
  /^text$/i,
  /^basic details$/i,
  /^mis reports$/i,
  /^tenders by /i,
  /^tenders in archive$/i,
  /^tenders status$/i,
  /^cancelled\/retendered$/i,
  /^downloads$/i,
  /^department list$/i,
  /^announcements$/i,
  /^recognitions$/i,
  /^site compatibility$/i,
  /^view more details$/i,
  /^tender details$/i,
  /eprocurement system/i,
];

function parseTeamsIncomingActivity(activity: Record<string, unknown>): GantryTeamsIncomingActivity {
  const conversation = asRecord(activity.conversation);
  const from = asRecord(activity.from);
  const channelData = asRecord(activity.channelData);
  const tenant = asRecord(channelData?.tenant);
  const conversationId = readString(conversation, "id") ?? "";
  const messageId = readString(activity, "id") ?? `teams:${conversationId}:${Date.now()}`;
  const type = readString(activity, "type");
  return {
    provider: "teams",
    type: type === "message" ? "message" : type === "invoke" ? "invoke" : "unknown",
    messageId,
    conversationId,
    replyToId: readString(activity, "replyToId"),
    text: readString(activity, "text"),
    value: activity.value,
    teamsTenantId: readString(tenant, "id") ?? readString(channelData, "tenantId"),
    teamsUserId: readString(from, "aadObjectId") ?? readString(from, "id"),
    teamsUserDisplayName: readString(from, "name"),
    raw: activity,
  };
}

function parseBotFrameworkActivity(activity: Activity): GantryTeamsIncomingActivity {
  return parseTeamsIncomingActivity(activity as unknown as Record<string, unknown>);
}

async function rememberTeamsConversationReference(
  storage: GantryRuntimeStorage,
  activity: Activity,
): Promise<void> {
  if (!storage.saveTeamsConversationReference) return;
  const conversationId = activity.conversation?.id;
  if (!conversationId || !activity.serviceUrl) return;
  const reference = TurnContext.getConversationReference(activity);
  const from = activity.from as { id?: string; aadObjectId?: string; name?: string } | undefined;
  const channelData = asRecord(activity.channelData);
  const tenant = asRecord(channelData?.tenant);
  await storage.saveTeamsConversationReference({
    exists: true,
    conversationId,
    conversationJid: normalizeTeamsJid(conversationId),
    serviceUrl: activity.serviceUrl,
    tenantId: readString(tenant, "id") ?? readString(channelData, "tenantId"),
    botId: activity.recipient?.id,
    teamsUserId: from?.aadObjectId ?? from?.id ?? null,
    rawReferenceJson: JSON.stringify(reference),
    updatedAt: new Date().toISOString(),
  });
}

async function readConversationReference(
  storage: GantryRuntimeStorage,
  conversationId: string,
): Promise<GantryTeamsStoredConversationReference> {
  const reference = await storage.getTeamsConversationReference?.(conversationId);
  if (!reference?.rawReferenceJson) {
    throw new Error(`No Teams conversation reference found for ${conversationId}.`);
  }
  return reference;
}

function parseStoredReference(
  reference: GantryTeamsStoredConversationReference,
  conversationId: string,
): Partial<ConversationReference> {
  const parsed = JSON.parse(reference.rawReferenceJson ?? "{}") as Partial<ConversationReference>;
  if (parsed.conversation) {
    parsed.conversation.id = conversationId;
  }
  return parsed;
}

function teamsBaseConversationIdFromThreadConversationId(conversationId: string): string {
  return conversationId.split(";messageid=")[0]?.trim() || conversationId;
}

function teamsThreadConversationId(conversationId: string, replyToId: string): string {
  const canonical = teamsBaseConversationIdFromThreadConversationId(conversationId);
  return `${canonical};messageid=${replyToId.trim()}`;
}

function isPersonalTeamsConversationReference(reference: Partial<ConversationReference>): boolean {
  const conversation = reference.conversation as { readonly conversationType?: string | null; readonly isGroup?: boolean | null } | undefined;
  return conversation?.conversationType === "personal" || conversation?.isGroup === false;
}

function createBotFrameworkResponse(res: ServerResponse): {
  status(code: number): { send(body: unknown): { end(): void }; end(): void };
  send(body: unknown): { end(): void };
  end(): void;
} {
  let pendingBody: unknown;
  const response = {
    status(code: number) {
      res.statusCode = code;
      return response;
    },
    send(body: unknown) {
      pendingBody = body;
      return response;
    },
    end() {
      if (res.writableEnded) return;
      if (pendingBody === undefined) {
        res.end();
      } else if (typeof pendingBody === "string" || Buffer.isBuffer(pendingBody)) {
        res.end(pendingBody);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(pendingBody));
      }
    },
  };
  return response;
}

function normalizeTeamsJid(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("teams:") ? trimmed : `teams:${trimmed}`;
}

function normalizeSqlIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return normalized;
}

function mapTeamsReferenceRow(row: Record<string, unknown> | undefined, fallbackConversationId: string): GantryTeamsStoredConversationReference | null {
  if (!row) return null;
  return {
    exists: true,
    conversationId: String(row.conversation_id ?? fallbackConversationId),
    conversationJid: typeof row.conversation_jid === "string" ? row.conversation_jid : null,
    serviceUrl: typeof row.service_url === "string" ? row.service_url : null,
    tenantId: typeof row.tenant_id === "string" ? row.tenant_id : null,
    botId: typeof row.bot_id === "string" ? row.bot_id : null,
    teamsUserId: typeof row.teams_user_id === "string" ? row.teams_user_id : null,
    rawReferenceJson: typeof row.raw_reference_json === "string" ? row.raw_reference_json : null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("Structured task model output must be a JSON object.");
  }
  return record;
}

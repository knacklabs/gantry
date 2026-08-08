export type ClientOptions = {
  apiKey: string;
  baseUrl?: string;
  socketPath?: string;
  timeoutMs?: number;
};

export type RequestOptions = {
  method: string;
  path: string;
  body?: unknown;
  contentType?: string;
  accept?: string;
  signal?: AbortSignal;
  traceparent?: string;
};

export type LlmRequestOptions = { traceparent?: string };
export type TraceRequestOptions = { traceparent?: string };

export type TransportResponse<T> = {
  body: T;
  headers: Readonly<Record<string, string | undefined>>;
};

export type RuntimeEventEnvelope = {
  eventId: number;
  streamPosition: number;
  eventType: string;
  sessionId?: string | null;
  jobId?: string | null;
  runId?: string | null;
  triggerId?: string | null;
  conversationId?: string | null;
  threadId?: string | null;
  correlationId?: string | null;
  createdAt?: string;
  payload: unknown;
};

export type SessionEventEnvelope = RuntimeEventEnvelope;
export type SseEvent = RuntimeEventEnvelope;

export type RuntimeEventQuery = {
  afterStreamPosition?: number;
  /** @deprecated Use afterStreamPosition for durable app event streams. */
  afterEventId?: number;
  limit?: number;
  sessionId?: string;
  jobId?: string;
  runId?: string;
  eventType?: string | string[];
};

export type RuntimeEventStreamOptions = RuntimeEventQuery & {
  signal?: AbortSignal;
};

export type RuntimeEventListResponse = { events: RuntimeEventEnvelope[] };

export type MemoryContext = {
  appId?: string;
  agentId?: string;
  personId?: string;
  groupId?: string;
  channelId?: string;
  threadId?: string;
};

export type MemorySaveInput = MemoryContext & {
  subjectType?: 'user' | 'group' | 'channel' | 'common';
  subjectId?: string;
  visibility?: 'user' | 'group' | 'channel' | 'common';
  kind?: 'preference' | 'decision' | 'fact' | 'correction' | 'constraint';
  key: string;
  value: string;
  why?: string;
  confidence?: number;
  source?: string;
  evidenceText?: string;
  evidenceIds?: string[];
  actorId?: string;
};

export type MemorySearchInput = MemoryContext & {
  query?: string;
  limit?: number;
  includeCommon?: boolean;
  subjectTypes?: Array<'user' | 'group' | 'channel' | 'common'>;
};

export type MemoryPatchInput = MemoryContext & {
  expectedVersion?: number;
  key?: string;
  value?: string;
  why?: string | null;
  confidence?: number;
  isPinned?: boolean;
};

export type MemoryReviewSubject = {
  appId?: string;
  agentId: string;
  subjectType: 'user' | 'group' | 'channel' | 'common';
  subjectId: string;
};

export type MemoryReviewListInput = MemoryReviewSubject & {
  limit?: number;
  offset?: number;
};

export type MemoryReviewDecisionInput = MemoryReviewSubject &
  (
    | { decision: 'edit_approve'; editedValue: string; reason?: string }
    | { decision: 'approve' | 'reject'; editedValue?: string; reason?: string }
  );

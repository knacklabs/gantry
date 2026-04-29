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
};

export type SseEvent = {
  eventId: number;
  eventType: string;
  payload: unknown;
};

export type MemoryContext = {
  appId?: string;
  agentId?: string;
  userId?: string;
  groupId?: string;
  channelId?: string;
  threadId?: string;
};

export type MemorySaveInput = MemoryContext & {
  subjectType?: 'user' | 'group' | 'channel' | 'common';
  subjectId?: string;
  visibility?: 'user' | 'group' | 'channel' | 'common';
  kind?:
    | 'preference'
    | 'decision'
    | 'fact'
    | 'correction'
    | 'constraint'
    | 'project_fact'
    | 'reference';
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

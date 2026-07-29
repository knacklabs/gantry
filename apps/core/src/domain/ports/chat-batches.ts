export const CHAT_BATCH_STATES = [
  'submission_intent',
  'preflight_failed',
  'submission_unknown',
  'submitted',
  'processing',
  'applied',
  'failed',
  'abandoned',
] as const;

export type ChatBatchState = (typeof CHAT_BATCH_STATES)[number];

export interface ChatBatchUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number | null;
}

export interface ChatBatchRecord {
  id: string;
  appId: string;
  providerId: string;
  model: string;
  correlationId: string;
  contentHash: string;
  state: ChatBatchState;
  providerBatchId: string | null;
  requestSnapshot: readonly Record<string, unknown>[];
  resultSnapshot: readonly Record<string, unknown>[] | null;
  requestCount: number;
  snapshotBytes: number;
  reservedCostUsd: number;
  usage: ChatBatchUsage;
  submitAttempts: number;
  pollAttempts: number;
  resultAttempts: number;
  attentionRequired: boolean;
  lastError: string | null;
  submittedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatBatchIntentCreate {
  id: string;
  appId: string;
  providerId: string;
  model: string;
  correlationId: string;
  contentHash: string;
  requestSnapshot: readonly Record<string, unknown>[];
  requestCount: number;
  snapshotBytes: number;
  reservedCostUsd: number;
  dailyCostLimitUsd: number;
  dayStartIso: string;
  dayEndIso: string;
  nowIso: string;
}

export class ChatBatchDailyCostLimitError extends Error {
  constructor() {
    super('Chat batch daily cost limit would be exceeded');
    this.name = 'ChatBatchDailyCostLimitError';
  }
}

export type ChatBatchAttemptPhase = 'poll' | 'result';

export interface ChatBatchRepository {
  createIntent(input: ChatBatchIntentCreate): Promise<ChatBatchRecord>;
  findById(id: string): Promise<ChatBatchRecord | null>;
  findByCorrelationId(input: {
    appId: string;
    providerId: string;
    correlationId: string;
  }): Promise<ChatBatchRecord | null>;
  listSubmissionUnknown(input: {
    appId?: string;
    limit: number;
  }): Promise<ChatBatchRecord[]>;
  recordPreflightFailure(
    input: ChatBatchIntentCreate & { error: string },
  ): Promise<ChatBatchRecord>;
  markSubmissionUnknown(input: {
    id: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null>;
  markSubmitted(input: {
    id: string;
    providerBatchId: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null>;
  markProcessing(input: {
    id: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null>;
  recordAttemptError(input: {
    id: string;
    phase: ChatBatchAttemptPhase;
    error: string;
    terminal: boolean;
    nowIso: string;
  }): Promise<ChatBatchRecord | null>;
  applyResults(input: {
    id: string;
    results: readonly Record<string, unknown>[];
    usage: ChatBatchUsage;
    nowIso: string;
  }): Promise<ChatBatchRecord | null>;
  abandonSubmission(input: {
    id: string;
    reason: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null>;
}

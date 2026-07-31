import type { ConversationId } from '../conversation/conversation.js';
import type { ProviderAccountId } from '../provider/provider.js';

export type ConversationHistoryScope =
  | { kind: 'channel'; id?: never }
  | { kind: 'thread'; id: string };

export interface ConversationHistoryCoverage {
  providerAccountId: ProviderAccountId;
  conversationId: ConversationId;
  scope: ConversationHistoryScope;
  complete: boolean;
  coveredThroughExternalId?: string;
  coveredThroughTimestamp?: string;
  providerGeneration: number;
  recordedAt: string;
  updatedAt: string;
}

export type ConversationHistoryCoverageWriteResult =
  | { status: 'written'; coverage: ConversationHistoryCoverage }
  | { status: 'stale'; currentGeneration: number };

export interface ConversationHistoryCoverageRepository {
  readProviderGeneration(providerAccountId: ProviderAccountId): Promise<number>;
  bumpProviderGeneration(providerAccountId: ProviderAccountId): Promise<number>;
  getCoverage(input: {
    providerAccountId: ProviderAccountId;
    conversationId: ConversationId;
    scope: ConversationHistoryScope;
  }): Promise<ConversationHistoryCoverage | null>;
  upsertCoverage(input: {
    providerAccountId: ProviderAccountId;
    conversationId: ConversationId;
    scope: ConversationHistoryScope;
    complete: boolean;
    coveredThroughExternalId?: string;
    coveredThroughTimestamp?: string;
    providerGeneration: number;
    recordedAt: string;
    updatedAt: string;
  }): Promise<ConversationHistoryCoverageWriteResult>;
}

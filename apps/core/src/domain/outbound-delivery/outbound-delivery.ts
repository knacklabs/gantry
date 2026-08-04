import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../conversation/conversation.js';
import type { AgentRunId } from '../events/events.js';
import type { ProviderAccountId, ProviderId } from '../provider/provider.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type OutboundDeliveryId = BrandedId<'OutboundDeliveryId'>;
export type OutboundDeliveryItemId = BrandedId<'OutboundDeliveryItemId'>;
export type OutboundDeliveryReceiptId = BrandedId<'OutboundDeliveryReceiptId'>;

export type OutboundDeliveryStatus =
  | 'pending'
  | 'claimed'
  | 'sent'
  | 'partially_delivered'
  | 'failed';

export type OutboundDeliveryItemStatus =
  | 'pending'
  | 'claimed'
  | 'sent'
  | 'failed'
  | 'partially_delivered';

export interface OutboundDelivery {
  id: OutboundDeliveryId;
  appId: AppId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  agentId?: AgentId;
  runId?: AgentRunId;
  profileId: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  status: OutboundDeliveryStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  settledAt?: IsoTimestamp;
  lastError?: string;
}

export interface OutboundDeliveryItem {
  id: OutboundDeliveryItemId;
  deliveryId: OutboundDeliveryId;
  ordinal: number;
  canonicalText: string;
  providerPayload?: unknown;
  status: OutboundDeliveryItemStatus;
  attemptCount: number;
  claimToken?: string;
  claimExpiresAt?: IsoTimestamp;
  nextAttemptAt: IsoTimestamp;
  sentAt?: IsoTimestamp;
  failedAt?: IsoTimestamp;
  lastError?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface OutboundDeliveryFinalAnswer {
  deliveryId: OutboundDeliveryId;
  canonicalText: string;
  segmentCount: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface OutboundDeliveryReceipt {
  id: OutboundDeliveryReceiptId;
  deliveryId: OutboundDeliveryId;
  itemId: OutboundDeliveryItemId;
  idempotencyKey: string;
  providerMessageId?: string;
  providerPayload?: unknown;
  sentAt: IsoTimestamp;
  createdAt: IsoTimestamp;
}

export interface OutboundDeliveryResolvedDestination {
  conversationJid: string;
  threadId?: string;
  providerId: ProviderId;
  providerAccountId: ProviderAccountId;
}

export interface ClaimedOutboundDeliveryItem {
  delivery: OutboundDelivery;
  item: OutboundDeliveryItem;
  finalAnswer: OutboundDeliveryFinalAnswer | null;
}

export class OutboundDeliveryIdempotencyConflictError extends Error {
  constructor(message = 'Outbound delivery idempotency key conflict') {
    super(message);
    this.name = 'OutboundDeliveryIdempotencyConflictError';
  }
}

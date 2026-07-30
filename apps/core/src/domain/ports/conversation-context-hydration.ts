import type { NewMessage } from '../types.js';

export interface ConversationContextHydrationRequest {
  conversationJid: string;
  providerAccountId?: string | null;
  threadId?: string | null;
  latestMessage: Pick<
    NewMessage,
    'id' | 'timestamp' | 'external_message_id' | 'thread_id'
  >;
  limits: {
    channelMessages: number;
    threadMessages: number;
  };
}

export interface HydrationRequestObservation {
  /** Which provider request this was. */
  role:
    | 'channel'
    | 'thread'
    | 'thread_tail'
    | 'thread_root'
    | 'thread_first_replies';
  limit: number;
  /** What was ACTUALLY sent to the provider, not the inbound source fields.
   *  Slack: derived ts cursor; Discord/Teams: before-message id; tails: oldest. */
  effectiveBounds: { cursor?: string; oldest?: string };
  rawMessageCount: number;
  /** This request's own pagination signals, untranslated. */
  pagination:
    | { kind: 'server_confirmed'; hasMore: boolean; hadCursor: boolean }
    | { kind: 'request_bounded' };
}

export interface ConversationContextHydrationCoverage {
  /** The latest-message input the request was built FROM (source fields). */
  requestedLatestMessage: { externalMessageId?: string; timestamp: string };
  scope: 'channel' | 'thread';
  requests: HydrationRequestObservation[];
  /** Derived claim. exhausted may only come from the full-range request's own
   *  pagination — never from a tail/root/first-replies observation. */
  completeness:
    | { kind: 'server_confirmed'; exhausted: boolean }
    | { kind: 'request_bounded' };
  /** Normalized output length — deliberately NOT called "returned": normalizers
   *  filter, dedupe and truncate, so raw counts live on the observations. */
  deliveredMessageCount: number;
  threadRoot: 'included' | 'missing' | 'not_applicable';
}

export interface ConversationContextHydrationResult {
  providerId: string;
  attempted: boolean;
  skipped?: boolean;
  failed?: boolean;
  reason?: string;
  messages?: NewMessage[];
  coverage?: ConversationContextHydrationCoverage;
}

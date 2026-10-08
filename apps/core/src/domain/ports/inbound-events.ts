import type { NewMessage } from '../types.js';
import type { LiveAdmissionInputScope } from './live-turns.js';

export const INBOUND_EVENT_BUDGET_MS = 120_000;
export const INBOUND_EVENT_ATTEMPT_MS = 20_000;
export const INBOUND_EVENT_CLAIM_MS = 30_000;
export const INBOUND_EVENT_RETRY_GAPS_MS = [
  1_000, 4_000, 10_000, 25_000, 40_000,
] as const;

export interface InboundControl {
  actorId: string;
  text: string;
  entities: unknown;
  routeSelector: string | null;
}

// Connection identity is bound by the host, never by the opening account.
export interface InboundEventInput {
  appId: string;
  providerId: string;
  connectionId: string;
  kind: 'message' | 'slash';
  eventKey: string;
  rawChannelId: string;
  rawThreadId: string | null;
  rawMessageId: string | null;
  payload: unknown;
  control: InboundControl | null;
}
// Fixed operation codes cannot carry message content or provider exceptions.
export type InboundMalformedReason =
  | 'missing_identity'
  | 'invalid_scope'
  | 'invalid_message';
export interface InboundMalformedEvent extends Omit<
  InboundEventInput,
  'kind' | 'control'
> {
  // Classifiers use the envelope key or stableSha256Json(payload); unknown channel is ''.
  kind: 'malformed';
  control: null;
  reason: InboundMalformedReason;
}
export type InboundSaveableEvent = InboundEventInput | InboundMalformedEvent;
export type InboundProviderId = InboundEventInput['providerId'];
export type InboundConnectionScope = Pick<
  InboundEventInput,
  'appId' | 'providerId' | 'connectionId'
>;
export type InboundRawThreadScope = InboundConnectionScope &
  Pick<InboundEventInput, 'rawChannelId' | 'rawThreadId'>;
export type InboundHeldDeleteScope = InboundConnectionScope & {
  rawChannelId: string;
  rawMessageIds: readonly string[];
};
export type InboundClassification =
  | { outcome: 'supported'; event: InboundEventInput }
  | { outcome: 'unsupported' }
  | {
      outcome: 'malformed';
      event: InboundMalformedEvent;
      reason: InboundMalformedReason;
    };

export interface InboundDestination {
  providerAccountId: string;
  agentId: string;
  conversationId: string;
  threadId: string | null;
}
export interface InboundRouteReceipt extends InboundDestination {
  outcome:
    | 'admitted'
    | 'dropped'
    | 'stopped'
    | 'answered'
    | 'control'
    | 'refused';
  targetTurnId: string | null;
  commandId: string | null;
}
// Raw controls are cleared at settlement; receipts cannot carry actor/text/arguments.
export interface InboundStopReceipt extends InboundRouteReceipt {
  outcome: 'control' | 'refused';
}
export interface InboundOrigin extends InboundRawThreadScope {
  eventId: string;
  seq: number;
  claimToken: string;
  deadlineAt: string;
}
export interface InboundAttemptContext {
  origin: InboundOrigin;
  signal: AbortSignal;
  remainingMs(): number;
}
export interface InboundUnpackedMessage {
  chatJid: string;
  message: NewMessage;
  destinations: InboundDestination[];
}
export interface InboundQuestionReply extends InboundRawThreadScope {
  providerAccountId: string;
  promptMessageId: string;
  promptAuthorId: string;
  promptAuthorIsBot: boolean;
  referenceAlias: string | null;
  actorId: string;
  answer: string;
}
export type InboundQuestionReplyResult =
  | { outcome: 'handled' }
  | { outcome: 'not_a_question' }
  | { outcome: 'stale_claim' };
// Only a genuinely missing binding permits ordinary-message fallback.
export type InboundQuestionReplyHandler = (
  reply: InboundQuestionReply,
  context: InboundAttemptContext,
) => Promise<InboundQuestionReplyResult>;
export type InboundUnpackResult =
  | { outcome: 'message'; value: InboundUnpackedMessage }
  | {
      outcome: 'question_reply';
      reply: InboundQuestionReply;
      fallback: NewMessage;
    }
  | { outcome: 'dropped' };
export interface InboundEventCodec {
  classify(
    payload: unknown,
    scope: InboundConnectionScope,
  ): InboundClassification;
  unpack(
    event: InboundEvent,
    context: InboundAttemptContext,
  ): Promise<InboundUnpackResult>;
  readControl(event: InboundEvent): InboundControl | null;
}
export interface InboundEvent extends Omit<InboundEventInput, 'kind'> {
  kind: InboundSaveableEvent['kind'];
  id: string;
  seq: number;
  state: 'pending' | 'claimed' | 'completed' | 'set_aside';
  deleted: boolean;
  attempts: number;
  claimToken: string | null;
  claimExpiresAt: string | null;
  deadlineAt: string | null;
  nextAttemptAt: string | null;
  unpacked: InboundUnpackResult | null;
  routeReceipts: InboundRouteReceipt[];
  failedOperation: string | null;
  receivedAt: string;
  settledAt: string | null;
}
export type InboundSaveResult =
  | { outcome: 'saved' | 'duplicate'; event: InboundEvent }
  | { outcome: 'unsupported' | 'invalid' };

export interface InboundClaimedEvent extends InboundEvent {
  state: 'claimed';
  claimToken: string;
  claimExpiresAt: string;
  deadlineAt: string;
}
export interface InboundClaimInput {
  scope: InboundConnectionScope;
  limit: number;
}
// Writes check state/token/deadline transactionally; release/set-aside may clear expired work.
export type InboundClaimGuard = Pick<
  InboundOrigin,
  'appId' | 'eventId' | 'claimToken' | 'deadlineAt'
>;
export type InboundWriteResult =
  | { outcome: 'applied' }
  | { outcome: 'stale_claim' };
export type InboundReceiptResult<T extends InboundRouteReceipt> =
  | { outcome: 'recorded' | 'duplicate'; receipt: T }
  | { outcome: 'stale_claim' };
export type InboundStopScope = InboundRawThreadScope & LiveAdmissionInputScope;
export interface InboundStopInput {
  origin: InboundOrigin;
  scope: InboundStopScope;
}
export interface InboundSweepInput {
  appId: string;
  settledBefore: string;
  limit: number;
}

export interface InboundEventRepository {
  save(input: unknown): Promise<InboundSaveResult>;
  get(id: string, appId: string): Promise<InboundEvent | null>;
  // Ordinary claims select at most four distinct raw thread heads; controls use a separate lane.
  claimHeads(input: InboundClaimInput): Promise<InboundClaimedEvent[]>;
  claimControls(input: InboundClaimInput): Promise<InboundClaimedEvent[]>;
  renew(input: InboundClaimGuard): Promise<InboundClaimedEvent | null>;
  release(input: InboundClaimGuard): Promise<InboundWriteResult>;
  cacheUnpacked(
    input: InboundClaimGuard & { unpacked: InboundUnpackResult },
  ): Promise<InboundWriteResult | { outcome: 'deleted' }>;
  settle(
    input: InboundClaimGuard,
  ): Promise<InboundWriteResult | { outcome: 'incomplete_routes' }>;
  retryLater(
    input: InboundClaimGuard & {
      nextAttemptAt: string;
      failedOperation: string;
    },
  ): Promise<InboundWriteResult>;
  setAside(
    input: InboundClaimGuard & { failedOperation: string },
  ): Promise<InboundWriteResult>;
  countSetAside(input: {
    appId: string;
  }): Promise<Record<InboundProviderId, number>>;
  sweepCompleted(input: InboundSweepInput): Promise<number>;
  markHeldDeleted(scope: InboundHeldDeleteScope): Promise<number>;
  recordStop(
    input: InboundStopInput,
  ): Promise<InboundReceiptResult<InboundStopReceipt>>;
  recordRouteReceipt(
    input: InboundClaimGuard & { receipt: InboundRouteReceipt },
  ): Promise<InboundReceiptResult<InboundRouteReceipt>>;
}
// T1 implements save/get; later owners activate the pinned lifecycle methods without stubs.
export type StagedInboundEventRepository = Pick<
  InboundEventRepository,
  'save' | 'get'
> &
  Partial<Omit<InboundEventRepository, 'save' | 'get'>>;
export type InboundEventSaver = (
  input: InboundSaveableEvent,
) => Promise<InboundSaveResult>;
export type InboundHeldDeleteGuard = InboundEventRepository['markHeldDeleted'];
export type InboundStopRecorder = InboundEventRepository['recordStop'];

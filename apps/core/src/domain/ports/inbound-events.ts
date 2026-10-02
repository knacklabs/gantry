import type { NewMessage } from '../types.js';

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
  | { outcome: 'unsupported' | 'malformed' };

export interface InboundDestination {
  providerAccountId: string;
  agentId: string;
  conversationId: string;
  threadId: string | null;
}
export interface InboundRouteReceipt extends InboundDestination {
  outcome: 'admitted' | 'dropped' | 'stopped' | 'answered' | 'refused';
  targetTurnId: string | null;
  commandId: string | null;
}
// Raw controls are cleared at settlement; receipts cannot carry actor/text/arguments.
export interface InboundStopReceipt extends InboundRouteReceipt {
  outcome: 'stopped' | 'refused';
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
export type InboundUnpackResult =
  | { outcome: 'message'; value: InboundUnpackedMessage }
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
export interface InboundEvent extends InboundEventInput {
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
  | { outcome: 'unsupported' | 'malformed' };
export interface InboundEventRepository {
  save(input: unknown): Promise<InboundSaveResult>;
  get(id: string, appId: string): Promise<InboundEvent | null>;
}
export type InboundEventSaver = (
  input: InboundEventInput,
) => Promise<InboundSaveResult>;
export type InboundHeldDeleteGuard = (
  scope: InboundHeldDeleteScope,
) => Promise<void>;
export type InboundStopRecorder = (input: {
  origin: InboundOrigin;
  destination: InboundDestination;
}) => Promise<InboundStopReceipt>;

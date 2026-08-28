export type CreateAttemptOutcome =
  | 'landed'
  | 'ambiguous'
  | 'definitively_missing'
  | 'skipped';

export type CreateAttempt = {
  stateKey: string;
  routeKey: string;
  progressKey: string;
  sequence: number;
  generation: number;
  providerSettlementDeadlineAt: number;
  done: boolean;
  consumedDefinitiveMissing: boolean;
  targetMessageId?: string;
  baseMessageId?: string;
  terminalBaseCompleted?: boolean;
  terminalMultipartCompleted?: boolean;
  terminalPartMessageIds?: string[];
  terminalPayloadFingerprint?: string;
  overflowPayloadFingerprint?: string;
  overflowPostInvoked?: boolean;
  invalidated?: boolean;
  outcome?: CreateAttemptOutcome;
  messageId?: string;
};

export type TrackedHandle = {
  messageId: string;
  sequence: number;
  terminal: boolean;
  terminalMultipart: boolean;
  terminalPartMessageIds?: string[];
  terminalPayloadFingerprint?: string;
};

export type ProgressKeyState = {
  routeKey: string;
  progressKey: string;
  generation: number;
  newestSequence: number;
  definitiveMissing: boolean;
  ambiguitySequence?: number;
  ambiguousOverflowPayloadFingerprint?: string;
  attempts: Map<number, CreateAttempt>;
  handle?: TrackedHandle;
  retentionTimer?: ReturnType<typeof setTimeout>;
};

export type CreateTombstone = Omit<ProgressKeyState, 'retentionTimer'>;

export type CreateSettlement = {
  handle?: TrackedHandle;
  definitiveMissing: boolean;
  clearActiveMessage: boolean;
  invalidatedMessageId?: string;
};

export function discordProgressStateKey(
  routeKey: string,
  progressKey: string,
): string {
  return JSON.stringify([routeKey, progressKey]);
}

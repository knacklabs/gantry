import type { FinalProgressState } from './progress-updates.js';

type GroupTurnRunResult = 'success' | 'error' | 'stopped';

export async function handleFailure(input: {
  outputSentToUser: boolean;
  acknowledgeFailedTurn?: boolean;
  groupName: string;
  queueJid: string;
  previousCursor: string;
  deps: {
    setCursor: (chatJid: string, timestamp: string) => void;
    saveState: () => Promise<void> | void;
  };
  logger: {
    warn(payload: Record<string, unknown>, message: string): void;
  };
}): Promise<boolean> {
  if (input.outputSentToUser) {
    input.logger.warn(
      { group: input.groupName },
      'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
    );
    return true;
  }
  if (input.acknowledgeFailedTurn) {
    await input.deps.saveState();
    input.logger.warn(
      { group: input.groupName },
      'Agent error on final retry, preserving message cursor to prevent stale replay',
    );
    return true;
  }
  input.deps.setCursor(input.queueJid, input.previousCursor);
  await input.deps.saveState();
  input.logger.warn(
    { group: input.groupName },
    'Agent error, rolled back message cursor for retry',
  );
  return false;
}

export function resetGroupStreamingForTurn(input: {
  chatJid: string;
  groupName: string;
  channelRuntime: { resetStreaming(jid: string): void };
  logger: { debug(payload: Record<string, unknown>, message: string): void };
}): void {
  try {
    input.channelRuntime.resetStreaming(input.chatJid);
  } catch (err) {
    input.logger.debug(
      { err, group: input.groupName },
      'Failed to reset channel streaming state before processing',
    );
  }
}

export async function waitOutput(input: {
  wait: () => Promise<void>;
  getError: () => unknown;
  hadError: boolean;
  groupName: string;
  logger: {
    error(payload: Record<string, unknown>, message: string): void;
  };
}): Promise<boolean> {
  await input.wait();
  const err = input.getError();
  if (!err) return input.hadError;
  input.logger.error(
    { group: input.groupName, err },
    'Agent output callback failed',
  );
  return true;
}

export function resolveGroupTurnFinalProgressState(input: {
  output: GroupTurnRunResult;
  hadError: boolean;
  sawDeliveryIncomplete: boolean;
  sawTerminalDeliveryFailure: boolean;
  outputSentToUser: boolean;
}): FinalProgressState {
  if (input.output === 'stopped') return 'stopped';
  if (input.output === 'error') return 'failed';
  if (input.hadError && !input.outputSentToUser) return 'failed';
  if (
    input.sawDeliveryIncomplete ||
    (input.sawTerminalDeliveryFailure && input.outputSentToUser)
  ) {
    return 'delivery_incomplete';
  }
  return input.sawTerminalDeliveryFailure ? 'failed' : 'completed';
}

export function shouldSendTurnFinalProgress(input: {
  finalProgressState: FinalProgressState;
  awaitingResponseReceipt: boolean;
  sentAnyTurnDoneProgress: boolean;
  activeGenerationHasOutput: boolean;
  sentTurnDoneProgressGeneration: number | null;
  progressGeneration: number;
}): boolean {
  return (
    !(
      input.finalProgressState === 'completed' && input.awaitingResponseReceipt
    ) &&
    (input.finalProgressState !== 'completed' ||
      !input.sentAnyTurnDoneProgress ||
      (input.activeGenerationHasOutput &&
        input.sentTurnDoneProgressGeneration !== input.progressGeneration))
  );
}

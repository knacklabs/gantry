import {
  sendFinalProgressUpdate,
  type FinalProgressState,
} from './progress-updates.js';
import type { ProgressUpdateOptions } from '../domain/types.js';
import type { GroupProcessOptions } from './group-processing-types.js';
import {
  resolveGroupTurnFinalProgressState,
  shouldSendTurnFinalProgress,
} from './group-processing-flow.js';

export function createGroupDoneProgressSender(input: {
  supportsProgress: boolean;
  pause: () => void;
  progressGeneration: () => number;
  finalizingGenerations: Set<number>;
  buildOptions: (generation: number) => ProgressUpdateOptions;
  send: (text: string, options?: ProgressUpdateOptions) => Promise<boolean>;
  onError: (err: unknown) => void;
}) {
  return async (
    state: FinalProgressState,
    generation = input.progressGeneration(),
    extraOptions: Pick<ProgressUpdateOptions, 'replaceOnly'> = {},
  ) => {
    if (!input.supportsProgress) return;
    if (input.progressGeneration() === generation) input.pause();
    input.finalizingGenerations.add(generation);
    await sendFinalProgressUpdate({
      enabled: true,
      state,
      options: { ...input.buildOptions(generation), ...extraOptions },
      send: input.send,
      onError: input.onError,
    });
  };
}

export function resolveGroupFinalProgressAction(input: {
  finalProgressState: FinalProgressState;
  finalRetry?: boolean;
  retryCount?: number;
  maxRetries?: number;
  outputSentToUser?: boolean;
  awaitingResponseReceipt: boolean;
  sentAnyTurnDoneProgress: boolean;
  activeGenerationHasOutput: boolean;
  sentTurnDoneProgressGeneration: number | null;
  progressGeneration: number;
}): { retryText?: string; sendDone: boolean; doneReplaceOnly?: boolean } {
  if (
    input.finalProgressState === 'failed' &&
    input.finalRetry !== true &&
    input.retryCount !== undefined &&
    input.maxRetries !== undefined
  ) {
    return {
      retryText: `retrying ${input.retryCount + 1}/${input.maxRetries}`,
      sendDone: false,
    };
  }
  const sendDone = shouldSendTurnFinalProgress(input);
  // A delivered answer already closes the turn, so "Done." may only update an
  // existing progress card (no stale "Working"), never post a new message.
  // "Done." stays a normal message for completed runs with no visible answer.
  return input.finalProgressState === 'completed' &&
    input.outputSentToUser &&
    sendDone
    ? { sendDone, doneReplaceOnly: true }
    : { sendDone };
}

export async function sendGroupFinalProgress(input: {
  output: Parameters<typeof resolveGroupTurnFinalProgressState>[0]['output'];
  hadError: boolean;
  sawDeliveryIncomplete: boolean;
  sawTerminalDeliveryFailure: boolean;
  outputSentToUser: boolean;
  options: GroupProcessOptions;
  awaitingResponseReceipt: boolean;
  sentAnyTurnDoneProgress: boolean;
  activeGenerationHasOutput: boolean;
  sentTurnDoneProgressGeneration: number | null;
  progressGeneration: number;
  supportsProgress: boolean;
  buildProgressOptions: (input: { replaceOnly: true }) => ProgressUpdateOptions;
  sendProgress: (
    text: string,
    options?: ProgressUpdateOptions,
  ) => Promise<void | boolean>;
  sendDone: (
    state: FinalProgressState,
    generation?: number,
    extraOptions?: Pick<ProgressUpdateOptions, 'replaceOnly'>,
  ) => Promise<void>;
}): Promise<void> {
  const finalProgressState = resolveGroupTurnFinalProgressState(input);
  const action = resolveGroupFinalProgressAction({
    ...input,
    finalProgressState,
    finalRetry: input.options.finalRetry,
    retryCount: input.options.retryCount,
    maxRetries: input.options.maxRetries,
  });
  if (action.retryText && input.supportsProgress) {
    await input
      .sendProgress(
        action.retryText,
        input.buildProgressOptions({ replaceOnly: true }),
      )
      .catch(() => undefined);
  } else if (action.sendDone) {
    await (action.doneReplaceOnly
      ? input.sendDone(finalProgressState, undefined, { replaceOnly: true })
      : input.sendDone(finalProgressState));
  }
}

import type { FinalProgressState } from './progress-updates.js';
import type { ProgressUpdateOptions } from '../domain/types.js';
import type { GroupProcessOptions } from './group-processing-types.js';
import {
  resolveGroupTurnFinalProgressState,
  shouldSendTurnFinalProgress,
} from './group-processing-flow.js';

export function resolveGroupFinalProgressAction(input: {
  finalProgressState: FinalProgressState;
  finalRetry?: boolean;
  retryCount?: number;
  maxRetries?: number;
  awaitingResponseReceipt: boolean;
  sentAnyTurnDoneProgress: boolean;
  activeGenerationHasOutput: boolean;
  sentTurnDoneProgressGeneration: number | null;
  progressGeneration: number;
}): { retryText?: string; sendDone: boolean } {
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
  return { sendDone: shouldSendTurnFinalProgress(input) };
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
  sendDone: (state: FinalProgressState) => Promise<void>;
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
    await input.sendDone(finalProgressState);
  }
}

import { describe, expect, it } from 'vitest';

import { resolveGroupFinalProgressAction } from '@core/runtime/group-final-progress-action.js';

const base = {
  awaitingResponseReceipt: false,
  sentAnyTurnDoneProgress: false,
  activeGenerationHasOutput: false,
  sentTurnDoneProgressGeneration: null,
  progressGeneration: 1,
};

describe('resolveGroupFinalProgressAction', () => {
  it('only updates an existing card (no new "Done." message) when an answer was delivered', () => {
    expect(
      resolveGroupFinalProgressAction({
        ...base,
        finalProgressState: 'completed',
        outputSentToUser: true,
      }),
    ).toEqual({ sendDone: true, doneReplaceOnly: true });
  });

  it('still posts "Done." when the run completed without a visible answer', () => {
    expect(
      resolveGroupFinalProgressAction({
        ...base,
        finalProgressState: 'completed',
        outputSentToUser: false,
      }),
    ).toEqual({ sendDone: true });
  });

  it.each(['failed', 'stopped', 'delivery_incomplete'] as const)(
    'still posts the %s status even when an answer was delivered',
    (finalProgressState) => {
      expect(
        resolveGroupFinalProgressAction({
          ...base,
          finalProgressState,
          outputSentToUser: true,
        }).sendDone,
      ).toBe(true);
    },
  );
});

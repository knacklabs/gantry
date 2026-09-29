import { describe, expect, it, vi } from 'vitest';

import { handleFailure } from '@core/runtime/group-processing-flow.js';

function makeInput(
  overrides: Partial<Parameters<typeof handleFailure>[0]> = {},
) {
  return {
    outputSentToUser: false,
    groupName: 'Main Agent',
    queueJid: 'sl:C1234567890',
    releaseInput: vi.fn().mockResolvedValue(1),
    deps: {
      setCursor: vi.fn(),
      saveState: vi.fn(),
    },
    logger: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('handleFailure', () => {
  it('releases a failed turn before output so the next turn can take its input', async () => {
    const input = makeInput();

    await expect(handleFailure(input)).resolves.toBe(false);

    expect(input.releaseInput).toHaveBeenCalledOnce();
    expect(input.deps.setCursor).not.toHaveBeenCalled();
    expect(input.logger.warn).toHaveBeenCalledWith(
      { group: 'Main Agent' },
      'Agent error, released input for retry',
    );
  });

  it.each([
    { outputSentToUser: true },
    { acknowledgeFailedTurn: true },
    { preserveCursor: true },
  ])(
    'keeps consumed input after output or terminal failure: %j',
    async (override) => {
      const input = makeInput(override);

      await expect(handleFailure(input)).resolves.toBe(true);

      expect(input.releaseInput).not.toHaveBeenCalled();
    },
  );
});

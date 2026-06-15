import { describe, expect, it, vi } from 'vitest';

import { handleFailure } from '@core/runtime/group-processing-flow.js';

function makeInput(
  overrides: Partial<Parameters<typeof handleFailure>[0]> = {},
) {
  return {
    outputSentToUser: false,
    groupName: 'Main Agent',
    queueJid: 'sl:C1234567890',
    previousCursor: 'prev-cursor',
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
  it('rolls back non-thread failures to the previous cursor', async () => {
    const input = makeInput();

    await expect(handleFailure(input)).resolves.toBe(false);

    expect(input.deps.setCursor).toHaveBeenCalledWith(
      'sl:C1234567890',
      'prev-cursor',
    );
    expect(input.deps.saveState).toHaveBeenCalledTimes(1);
  });

  it('preserves an advanced first thread cursor to avoid restart replay loops', async () => {
    const input = makeInput({
      queueJid: 'sl:C1234567890::thread:1711111111.000200',
      previousCursor: '',
    });

    await expect(handleFailure(input)).resolves.toBe(true);

    expect(input.deps.setCursor).not.toHaveBeenCalled();
    expect(input.deps.saveState).not.toHaveBeenCalled();
    expect(input.logger.warn).toHaveBeenCalledWith(
      {
        group: 'Main Agent',
        queueJid: 'sl:C1234567890::thread:1711111111.000200',
      },
      'Agent error on first thread message, preserving cursor to avoid replay loop',
    );
  });

  it('preserves the cursor when a run fails during runtime shutdown', async () => {
    const input = makeInput({
      isShuttingDown: () => true,
    });

    await expect(handleFailure(input)).resolves.toBe(true);

    expect(input.deps.setCursor).not.toHaveBeenCalled();
    expect(input.deps.saveState).not.toHaveBeenCalled();
    expect(input.logger.warn).toHaveBeenCalledWith(
      {
        group: 'Main Agent',
        queueJid: 'sl:C1234567890',
      },
      'Agent error during runtime shutdown, preserving cursor to avoid restart replay',
    );
  });

  it('still rolls back thread failures when a durable previous cursor exists', async () => {
    const input = makeInput({
      queueJid: 'sl:C1234567890::thread:1711111111.000200',
      previousCursor: 'prev-thread-cursor',
    });

    await expect(handleFailure(input)).resolves.toBe(false);

    expect(input.deps.setCursor).toHaveBeenCalledWith(
      'sl:C1234567890::thread:1711111111.000200',
      'prev-thread-cursor',
    );
    expect(input.deps.saveState).toHaveBeenCalledTimes(1);
  });
});

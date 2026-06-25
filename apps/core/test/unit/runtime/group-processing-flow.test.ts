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

  it('preserves the cursor for final retry failures', async () => {
    const input = makeInput({
      acknowledgeFailedTurn: true,
    });

    await expect(handleFailure(input)).resolves.toBe(true);

    expect(input.deps.setCursor).not.toHaveBeenCalled();
    expect(input.deps.saveState).toHaveBeenCalledTimes(1);
    expect(input.logger.warn).toHaveBeenCalledWith(
      { group: 'Main Agent' },
      'Agent error on final retry, preserving message cursor to prevent stale replay',
    );
  });

  it('rolls back first thread failures to the empty cursor for retry', async () => {
    const input = makeInput({
      queueJid: 'sl:C1234567890::thread:1711111111.000200',
      previousCursor: '',
    });

    await expect(handleFailure(input)).resolves.toBe(false);

    expect(input.deps.setCursor).toHaveBeenCalledWith(
      'sl:C1234567890::thread:1711111111.000200',
      '',
    );
    expect(input.deps.saveState).toHaveBeenCalledTimes(1);
    expect(input.logger.warn).toHaveBeenCalledWith(
      { group: 'Main Agent' },
      'Agent error, rolled back message cursor for retry',
    );
  });

  it('rolls back no-output failures during runtime shutdown', async () => {
    const input = makeInput();

    await expect(handleFailure(input)).resolves.toBe(false);

    expect(input.deps.setCursor).toHaveBeenCalledWith(
      'sl:C1234567890',
      'prev-cursor',
    );
    expect(input.deps.saveState).toHaveBeenCalledTimes(1);
    expect(input.logger.warn).toHaveBeenCalledWith(
      { group: 'Main Agent' },
      'Agent error, rolled back message cursor for retry',
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

import { describe, expect, it, vi } from 'vitest';

import {
  initializeSandboxRuntimeWithRetry,
  isRetryableSandboxInitializationError,
} from '@core/adapters/sandbox/sandbox-runtime-runner.js';

const config = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: false,
  },
  filesystem: {
    allowRead: [],
    denyRead: [],
    allowWrite: [],
    denyWrite: [],
  },
};

describe('sandbox runtime initialization', () => {
  it('retries a transient Linux bridge startup failure with a fresh reset', async () => {
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Failed to create bridge sockets after 5 attempts'),
      )
      .mockResolvedValueOnce(undefined);
    const reset = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await initializeSandboxRuntimeWithRetry(config, {
      initialize,
      reset,
      wait,
    });

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it('does not retry configuration or dependency failures', async () => {
    const initialize = vi
      .fn()
      .mockRejectedValue(new Error('Sandbox dependencies not available'));
    const reset = vi.fn();

    await expect(
      initializeSandboxRuntimeWithRetry(config, { initialize, reset }),
    ).rejects.toThrow('Sandbox dependencies not available');
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('classifies only transient Linux bridge startup errors as retryable', () => {
    expect(
      isRetryableSandboxInitializationError(
        new Error('Linux bridge process died unexpectedly'),
      ),
    ).toBe(true);
    expect(
      isRetryableSandboxInitializationError(
        new Error('Sandbox runtime requires a config file path.'),
      ),
    ).toBe(false);
  });
});

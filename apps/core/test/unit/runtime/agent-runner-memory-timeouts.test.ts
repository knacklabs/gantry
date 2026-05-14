import { describe, expect, it } from 'vitest';

import {
  formatMemoryTimeoutError,
  getMemoryActionTimeoutMs,
} from '../../../src/runner/memory-timeouts.js';

describe('agent-runner memory timeout helpers', () => {
  it('uses extended timeout for memory consolidation and dreaming actions', () => {
    expect(getMemoryActionTimeoutMs('memory_consolidate')).toBe(60_000);
    expect(getMemoryActionTimeoutMs('memory_dream')).toBe(60_000);
  });

  it('uses default timeout for non-long-running memory actions', () => {
    expect(getMemoryActionTimeoutMs('memory_search')).toBe(15_000);
    expect(getMemoryActionTimeoutMs('memory_save')).toBe(15_000);
    expect(getMemoryActionTimeoutMs('memory_patch')).toBe(15_000);
    expect(getMemoryActionTimeoutMs('procedure_save')).toBe(15_000);
    expect(getMemoryActionTimeoutMs('procedure_patch')).toBe(15_000);
  });

  it('formats timeout error with the configured timeout value', () => {
    expect(formatMemoryTimeoutError(60_000)).toBe(
      'Timed out waiting for memory service response (1 min)',
    );
  });
});

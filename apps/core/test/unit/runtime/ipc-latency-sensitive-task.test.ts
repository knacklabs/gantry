import { describe, expect, it } from 'vitest';

import { isLatencySensitiveTaskType } from '@core/runtime/ipc.js';

describe('latency-sensitive IPC tasks', () => {
  it('keeps caller-resolved tools off the potentially blocked general scan', () => {
    expect(isLatencySensitiveTaskType('caller_resolved_tool')).toBe(true);
  });
});

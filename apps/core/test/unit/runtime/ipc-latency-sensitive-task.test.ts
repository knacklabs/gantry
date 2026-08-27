import { describe, expect, it } from 'vitest';

import { isLatencySensitiveTaskType } from '@core/runtime/ipc.js';

describe('latency-sensitive IPC tasks', () => {
  it.each([
    'attachment_open',
    'attachment_materialize',
    'captcha_vision_solve',
    'caller_resolved_tool',
    'mcp_list_tools',
    'mcp_search_tools',
    'mcp_describe_tool',
  ])('keeps %s off the potentially blocked general scan', (type) => {
    expect(isLatencySensitiveTaskType(type)).toBe(true);
  });
});

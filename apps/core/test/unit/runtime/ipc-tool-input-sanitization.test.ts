import { describe, expect, it } from 'vitest';

import {
  sanitizeIpcToolInput,
  toolInputMaxDepthForTool,
} from '@core/runtime/ipc-tool-input-sanitization.js';

const requestAccessInput = {
  target: {
    kind: 'mcp_capability',
    serverName: 'docs',
    tools: ['list_pages', 'get_page'],
    displayName: 'Read docs',
  },
  reason: 'Read the docs.',
  riskClass: 'low',
};

describe('toolInputMaxDepthForTool', () => {
  it('keeps request_access mcp tool lists whole instead of truncating them', () => {
    for (const name of ['request_access', 'mcp__gantry__request_access']) {
      const result = sanitizeIpcToolInput(
        requestAccessInput,
        undefined,
        toolInputMaxDepthForTool(name),
      );
      expect(result.truncatedPaths).toEqual([]);
      expect(result.toolInput).toEqual(requestAccessInput);
    }
  });

  it('keeps the default depth for every other tool', () => {
    expect(toolInputMaxDepthForTool('Bash')).toBe(2);
    const result = sanitizeIpcToolInput(
      requestAccessInput,
      undefined,
      toolInputMaxDepthForTool('mcp__other__tool'),
    );
    expect(result.truncatedPaths).toContain('target.tools.0');
  });
});

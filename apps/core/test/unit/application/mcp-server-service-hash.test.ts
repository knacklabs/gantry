import { describe, expect, it } from 'vitest';

import { hashMcpConfig } from '@core/application/mcp/mcp-server-service.js';

describe('hashMcpConfig', () => {
  it('uses deterministic SHA-256 over canonical JSON', () => {
    const left = hashMcpConfig({
      config: { url: 'https://mcp.example.test', transport: 'http' },
      allowedToolPatterns: ['search'],
    });
    const right = hashMcpConfig({
      allowedToolPatterns: ['search'],
      config: { transport: 'http', url: 'https://mcp.example.test' },
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

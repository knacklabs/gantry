import { describe, expect, it } from 'vitest';

import { materializeMcpRecord } from '@core/application/mcp/mcp-server-materialization.js';

function recordWithTemplate(templateId: string | undefined) {
  return {
    definition: {
      name: 'github',
      config: { transport: 'stdio_template', templateId },
      credentialRefs: [],
      allowedToolPatterns: ['search'],
      autoApproveToolPatterns: [],
    },
    binding: { required: false },
  } as never;
}

function recordWithRemoteTransport(transport: 'http' | 'sse') {
  return {
    definition: {
      name: 'github',
      config: { transport, url: 'https://mcp.example.test/github' },
      credentialRefs: [],
      allowedToolPatterns: ['search'],
      autoApproveToolPatterns: [],
    },
    binding: { required: false },
  } as never;
}

describe('materializeMcpRecord', () => {
  it('throws a typed error for unsupported persisted stdio templates', () => {
    expect(() =>
      materializeMcpRecord(recordWithTemplate('removed-template'), {}),
    ).toThrow(/unsupported templateId/);
    try {
      materializeMcpRecord(recordWithTemplate(undefined), {});
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });

  it('fails closed instead of projecting remote MCP servers directly to the SDK', () => {
    for (const transport of ['http', 'sse'] as const) {
      expect(() =>
        materializeMcpRecord(recordWithRemoteTransport(transport), {}),
      ).toThrow(/DNS-pinned host transport/);
    }
  });
});

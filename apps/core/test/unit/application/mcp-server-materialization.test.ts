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

function recordWithRemoteTransport(
  transport: 'http' | 'sse',
  input: {
    headers?: Record<string, string>;
    credentialRefs?: Array<{
      name: string;
      target: 'env' | 'header';
      key: string;
    }>;
  } = {},
) {
  return {
    definition: {
      name: 'github',
      config: {
        transport,
        url: 'https://mcp.example.test/github',
        ...(input.headers ? { headers: input.headers } : {}),
      },
      credentialRefs: input.credentialRefs ?? [],
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

  it('materializes remote MCP servers for the guarded proxy transport', () => {
    for (const transport of ['http', 'sse'] as const) {
      expect(
        materializeMcpRecord(recordWithRemoteTransport(transport), {}).config,
      ).toEqual({
        type: transport,
        url: 'https://mcp.example.test/github',
      });
    }
  });

  it('projects remote MCP credential refs as headers', () => {
    expect(
      materializeMcpRecord(
        recordWithRemoteTransport('http', {
          headers: { 'x-base': '1' },
          credentialRefs: [
            {
              name: 'GITHUB_MCP_TOKEN',
              target: 'header',
              key: 'Authorization',
            },
          ],
        }),
        { GITHUB_MCP_TOKEN: 'Bearer test-token' },
      ).config,
    ).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/github',
      headers: { 'x-base': '1', Authorization: 'Bearer test-token' },
    });
  });

  it('narrows effective tools to the per-agent binding scope', () => {
    const record = {
      definition: {
        name: 'github',
        config: { transport: 'stdio_template', templateId: 'npx-package' },
        credentialRefs: [],
        allowedToolPatterns: ['read_*', 'write_*'],
        autoApproveToolPatterns: [],
      },
      binding: { required: false, allowedToolPatterns: ['read_*'] },
    } as never;
    expect(materializeMcpRecord(record, {}).allowedToolPatterns).toEqual([
      'read_*',
    ]);
  });

  it('inherits the definition tool set when the binding declares no scope', () => {
    const record = {
      definition: {
        name: 'github',
        config: { transport: 'stdio_template', templateId: 'npx-package' },
        credentialRefs: [],
        allowedToolPatterns: ['read_*', 'write_*'],
        autoApproveToolPatterns: [],
      },
      binding: { required: false, allowedToolPatterns: [] },
    } as never;
    expect(materializeMcpRecord(record, {}).allowedToolPatterns).toEqual([
      'read_*',
      'write_*',
    ]);
  });
});

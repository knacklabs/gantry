import { describe, expect, it } from 'vitest';

import {
  mcpCallToolProxyInput,
  mcpListToolsProxyInput,
} from '@core/jobs/ipc-mcp-list-tools-input.js';

describe('mcpListToolsProxyInput', () => {
  it('normalizes bounded MCP list/search fields for the proxy', () => {
    expect(
      mcpListToolsProxyInput({
        serverName: ' github ',
        query: ' issue ',
        limit: 5.9,
        cursor: '10',
      }),
    ).toEqual({
      serverName: 'github',
      query: 'issue',
      limit: 5,
      cursor: '10',
    });
  });

  it('omits empty strings and non-numeric limits', () => {
    expect(
      mcpListToolsProxyInput({
        serverName: ' ',
        query: '',
        limit: '20',
        cursor: '\n',
      }),
    ).toEqual({});
  });
});

describe('mcpCallToolProxyInput', () => {
  it('reports missing names and non-object argument payloads', () => {
    expect(
      mcpCallToolProxyInput({
        serverName: ' ',
        toolName: 'create_issue',
        arguments: 'token=secret-value',
      }),
    ).toEqual({
      toolName: 'create_issue',
      argumentPayload: 'token=secret-value',
      missingFields: ['serverName'],
      invalidArguments: true,
    });
  });

  it('accepts object argument payloads without leaking values into validation', () => {
    expect(
      mcpCallToolProxyInput({
        serverName: 'github',
        toolName: 'create_issue',
        arguments: { title: 'Bug' },
      }),
    ).toEqual({
      serverName: 'github',
      toolName: 'create_issue',
      arguments: { title: 'Bug' },
      argumentPayload: { title: 'Bug' },
      missingFields: [],
      invalidArguments: false,
    });
  });
});

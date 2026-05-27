import { describe, expect, it } from 'vitest';

import { ApplicationError } from '@core/application/common/application-error.js';
import { materializeMcpRecord } from '@core/application/mcp/mcp-server-materialization.js';
import type { MaterializedMcpServer } from '@core/domain/mcp/mcp-servers.js';

function buildHttpRecord(
  url: string,
  overrides: Partial<MaterializedMcpServer['version']> = {},
): MaterializedMcpServer {
  return {
    definition: {
      id: 'srv-1' as never,
      appId: 'app-1' as never,
      name: 'inventory-api',
      status: 'approved',
      createdBy: 'admin',
      createdSource: 'admin',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as never,
    version: {
      id: 'ver-1' as never,
      serverId: 'srv-1' as never,
      versionNumber: 1,
      transport: 'http',
      config: {
        transport: 'http',
        url,
      },
      allowedToolPatterns: ['get_*'],
      autoApproveToolPatterns: ['get_*'],
      riskClass: 'medium',
      credentialRefs: [],
      createdAt: new Date(0).toISOString(),
      ...overrides,
    } as never,
    binding: {
      id: 'bind-1' as never,
      appId: 'app-1' as never,
      agentId: 'agent-1' as never,
      serverId: 'srv-1' as never,
      versionId: 'ver-1' as never,
      status: 'active',
      required: false,
      createdAt: new Date(0).toISOString(),
    } as never,
  };
}

describe('materializeMcpRecord (loopback http/sse projection)', () => {
  it('projects http://127.0.0.1 to an SDK http config', () => {
    const record = buildHttpRecord('http://127.0.0.1:8081/mcp');
    const cap = materializeMcpRecord(record, {});
    expect(cap.config.type).toBe('http');
    expect(cap.config).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8081/mcp',
    });
    expect(cap.allowedToolNames).toContain('mcp__inventory-api__get_*');
  });

  it('projects http://[::1] to an SDK http config', () => {
    const record = buildHttpRecord('http://[::1]:8081/mcp');
    const cap = materializeMcpRecord(record, {});
    expect(cap.config.type).toBe('http');
  });

  it('projects loopback sse to an SDK sse config', () => {
    const record = buildHttpRecord('http://127.0.0.1:8081/sse', {
      transport: 'sse',
      config: { transport: 'sse', url: 'http://127.0.0.1:8081/sse' },
    } as never);
    const cap = materializeMcpRecord(record, {});
    expect(cap.config.type).toBe('sse');
  });

  it('attaches header-targeted credentialRefs as config.headers', () => {
    const record = buildHttpRecord('http://127.0.0.1:8081/mcp', {
      credentialRefs: [
        { name: 'MCP_AUTH', target: 'header', key: 'Authorization' },
      ],
    } as never);
    const cap = materializeMcpRecord(record, { MCP_AUTH: 'Bearer xyz' });
    expect(cap.config.type).toBe('http');
    expect(
      (cap.config as { headers?: Record<string, string> }).headers,
    ).toEqual({ Authorization: 'Bearer xyz' });
  });

  it('preserves caller identity config for spawn-time signing', () => {
    const record = buildHttpRecord('http://127.0.0.1:8081/mcp', {
      config: {
        transport: 'http',
        url: 'http://127.0.0.1:8081/mcp',
        callerIdentity: {
          mode: 'required',
          headerName: 'x-caller-identity',
          signingRef: 'CUSTOMER_API_IDENTITY_SECRET',
          source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
        },
      },
    } as never);
    const cap = materializeMcpRecord(record, {});
    expect(cap.callerIdentity).toEqual({
      mode: 'required',
      headerName: 'x-caller-identity',
      signingRef: 'CUSTOMER_API_IDENTITY_SECRET',
      source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
    });
    expect((cap.config as { headers?: Record<string, string> }).headers).toBe(
      undefined,
    );
  });

  it('still throws for non-loopback http', () => {
    const record = buildHttpRecord('http://example.com/mcp');
    expect(() => materializeMcpRecord(record, {})).toThrow(ApplicationError);
  });

  it('still throws for https://example.com (production-style remote)', () => {
    const record = buildHttpRecord('https://api.example.com/mcp');
    expect(() => materializeMcpRecord(record, {})).toThrow(ApplicationError);
  });
});

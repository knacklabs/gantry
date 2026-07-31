import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendSdkMcpAuditActivity,
  createJsonRpcFrameObserver,
  mcpToolOutputWithProvenance,
  prepareExternalMcpStdioAudit,
} from '@core/adapters/llm/anthropic-claude-agent/runner/mcp-stdio-audit.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('external stdio MCP audit', () => {
  it('observes newline and Content-Length JSON-RPC frames across chunks', () => {
    const values: unknown[] = [];
    const observe = createJsonRpcFrameObserver((value) => values.push(value));
    observe(
      Buffer.from('{"jsonrpc":"2.0","id":"line","method":"tools/call"}\n'),
    );
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: 'framed', result: { ok: true } }),
    );
    const framed = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
      body,
    ]);
    observe(framed.subarray(0, 12));
    observe(framed.subarray(12));

    expect(values).toEqual([
      { jsonrpc: '2.0', id: 'line', method: 'tools/call' },
      { jsonrpc: '2.0', id: 'framed', result: { ok: true } },
    ]);
  });

  it('wraps external stdio servers but leaves Gantry and HTTP servers intact', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'gantry-mcp-audit-'));
    tempDirectories.push(workspaceDir);
    const gantry = { command: 'node', args: ['gantry.js'] } as const;
    const remote = { type: 'http', url: 'https://mcp.test' } as const;
    const audit = prepareExternalMcpStdioAudit({
      workspaceDir,
      runId: 'run-1',
      mcpServers: {
        gantry,
        remote,
        firecrawl: {
          command: 'npx',
          args: ['-y', 'firecrawl-mcp'],
          env: { FIRECRAWL_API_KEY: 'secret' },
        },
      },
    });

    expect(audit.mcpServers.gantry).toMatchObject({
      ...gantry,
      env: {
        GANTRY_MCP_STDIO_AUDIT_FILE: expect.stringContaining(
          join('.llm-runtime', 'claude', 'mcp-audit'),
        ),
      },
    });
    expect(audit.mcpServers.remote).toBe(remote);
    expect(audit.mcpServers.firecrawl).toMatchObject({
      command: process.execPath,
      args: [
        expect.stringContaining('mcp-stdio-audit-proxy.js'),
        'npx',
        '-y',
        'firecrawl-mcp',
      ],
      env: {
        FIRECRAWL_API_KEY: 'secret',
        PATH: process.env.PATH,
        GANTRY_MCP_STDIO_AUDIT_SERVER_NAME: 'firecrawl',
      },
    });
    audit.cleanup();
  });

  it('drains complete redacted audit records incrementally', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'gantry-mcp-audit-'));
    tempDirectories.push(workspaceDir);
    const audit = prepareExternalMcpStdioAudit({
      workspaceDir,
      runId: 'run-2',
      mcpServers: { firecrawl: { command: 'firecrawl-mcp' } },
    });
    const env = audit.mcpServers.firecrawl?.env ?? {};
    const auditFile = env.GANTRY_MCP_STDIO_AUDIT_FILE;
    expect(auditFile).toBeTypeOf('string');
    expect(auditFile).toContain(join('.llm-runtime', 'claude', 'mcp-audit'));
    const record = {
      toolCallId: 'call-1',
      serverName: 'firecrawl',
      toolName: 'firecrawl_search',
      requestedToolRule: 'mcp__firecrawl__firecrawl_search',
      resultClass: 'success',
      latencyMs: 12,
      argumentSummary: { kind: 'object' },
      inputHash: 'sha256:input',
      resultHash: 'sha256:result',
      evidenceProjection: [{ path: 'data.url', value: 'https://example.test' }],
    };
    appendFileSync(auditFile!, `${JSON.stringify(record)}\n`, 'utf8');

    expect(audit.drain()).toEqual([record]);
    expect(audit.drain()).toEqual([]);
    audit.cleanup();
  });

  it('records the Claude tool-use UUID for external MCP success evidence', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'gantry-mcp-audit-'));
    tempDirectories.push(workspaceDir);
    const audit = prepareExternalMcpStdioAudit({
      workspaceDir,
      runId: 'run-sdk-id',
      mcpServers: {
        gantry: { command: 'node', args: ['gantry.js'] },
        firecrawl: { command: 'firecrawl-mcp' },
      },
    });

    appendSdkMcpAuditActivity({
      auditFile: audit.auditFile,
      serverNames: Object.keys(audit.mcpServers),
      hook: {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__firecrawl__firecrawl_search',
        tool_input: { query: 'government tenders' },
        tool_use_id: '019f-tool-use-uuid',
        tool_response: { data: [{ url: 'https://example.test' }] },
        duration_ms: 42,
      },
    });

    expect(audit.drain()).toEqual([
      expect.objectContaining({
        toolCallId: '019f-tool-use-uuid',
        serverName: 'firecrawl',
        toolName: 'firecrawl_search',
        resultClass: 'success',
        latencyMs: 42,
      }),
    ]);
    audit.cleanup();
  });

  it('adds the exact Gantry provenance ID without replacing MCP evidence', () => {
    const response = [{ type: 'text', text: 'evidence' }];

    expect(mcpToolOutputWithProvenance(response, 'toolu_exact')).toEqual([
      { type: 'text', text: 'evidence' },
      {
        type: 'text',
        text: JSON.stringify({
          gantryProvenance: { toolCallId: 'toolu_exact' },
        }),
      },
    ]);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolCallRecord } from '@core/runtime/reply-trace.js';

const runtimeHomes: string[] = [];

/**
 * Loads the admin handlers with McpToolProxy + storage mocked so the MCP
 * tool-call handler resolves a known result and we can assert the trace record
 * pushed into the injected collector hook.
 */
async function loadHandlers(
  runtimeHome: string,
  callToolResult: unknown,
) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);

  vi.doMock('@core/application/mcp/mcp-tool-proxy.js', () => ({
    McpToolProxy: class {
      async callTool() {
        return callToolResult;
      }
    },
  }));
  vi.doMock(
    '@core/application/capability-secrets/mcp-secret-projection.js',
    () => ({
      resolveMcpCredentialEnvForAgent: vi.fn(async () => ({})),
    }),
  );
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeRepositories: vi.fn(() => ({})),
    getRuntimeStorage: vi.fn(() => ({
      repositories: { mcpServers: {}, tools: {}, skills: {}, capabilitySecrets: {} },
    })),
  }));

  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handlers = await import('@core/jobs/ipc-admin-handlers.js');
  return { handlers, ipcAuth };
}

function makeContext(opts: {
  recordReplyToolCall?: (runHandle: string, record: ToolCallRecord) => void;
  runHandle?: string;
  responseKeyId: string;
}) {
  const chatJid = 'chat@s.whatsapp.net';
  return {
    data: {
      type: 'mcp_call_tool',
      taskId: 'task-mcp-1',
      appId: 'app:test',
      responseKeyId: opts.responseKeyId,
      chatJid,
      targetJid: chatJid,
      ...(opts.runHandle ? { runHandle: opts.runHandle } : {}),
      payload: {
        serverName: 'some-server',
        toolName: 'some_tool',
        arguments: { q: 'hello' },
      },
    },
    sourceAgentFolder: 'main_agent',
    ipcBaseDir: undefined,
    deps: {
      sendMessage: vi.fn(async () => undefined),
      registerGroup: vi.fn(async () => undefined),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      onSchedulerChanged: vi.fn(() => undefined),
      requestPermissionApproval: vi.fn(),
      requestUserAnswer: vi.fn(async () => ({ response: '' })),
      opsRepository: {},
      ...(opts.recordReplyToolCall
        ? { recordReplyToolCall: opts.recordReplyToolCall }
        : {}),
    } as never,
    conversationBindings: {},
    sourceAgentFolderJids: [chatJid],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@core/application/mcp/mcp-tool-proxy.js');
  vi.doUnmock('@core/application/capability-secrets/mcp-secret-projection.js');
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  for (const home of runtimeHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('mcpCallToolHandler trace capture', () => {
  it('records a ToolCallRecord keyed by runHandle with server/tool/ms/ok/bytes', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    delete process.env.GANTRY_TRACE_PAYLOADS;
    const captured: { runHandle: string; record: ToolCallRecord }[] = [];
    const { handlers, ipcAuth } = await loadHandlers(runtimeHome, {
      content: [{ type: 'text', text: 'a result' }],
    });
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const ctx = makeContext({
      runHandle: 'gantry-run-123',
      responseKeyId: envelope.responseKeyId,
      recordReplyToolCall: (runHandle, record) =>
        captured.push({ runHandle, record }),
    });

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(captured.length).toBe(1);
    expect(captured[0].runHandle).toBe('gantry-run-123');
    const rec = captured[0].record;
    expect(rec.server).toBe('some-server');
    expect(rec.tool).toBe('some_tool');
    expect(rec.ok).toBe(true);
    expect(typeof rec.ms).toBe('number');
    expect(rec.requestBytes).toBeGreaterThan(0);
    expect(rec.responseBytes).toBeGreaterThan(0);
    // payloads omitted when the flag is off
    expect(rec.request).toBeUndefined();
    expect(rec.response).toBeUndefined();
  });

  it('includes request/response payloads only when GANTRY_TRACE_PAYLOADS=1', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    process.env.GANTRY_TRACE_PAYLOADS = '1';
    const captured: ToolCallRecord[] = [];
    const { handlers, ipcAuth } = await loadHandlers(runtimeHome, {
      content: [{ type: 'text', text: 'a result' }],
    });
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const ctx = makeContext({
      runHandle: 'gantry-run-xyz',
      responseKeyId: envelope.responseKeyId,
      recordReplyToolCall: (_runHandle, record) => captured.push(record),
    });

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(captured[0].request).toEqual({ q: 'hello' });
    expect(captured[0].response).toEqual({
      content: [{ type: 'text', text: 'a result' }],
    });
    delete process.env.GANTRY_TRACE_PAYLOADS;
  });

  it('marks ok=false when the MCP result carries isError', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const captured: ToolCallRecord[] = [];
    const { handlers, ipcAuth } = await loadHandlers(runtimeHome, {
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    });
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const ctx = makeContext({
      runHandle: 'gantry-run-err',
      responseKeyId: envelope.responseKeyId,
      recordReplyToolCall: (_runHandle, record) => captured.push(record),
    });

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);
    expect(captured[0].ok).toBe(false);
  });

  it('does not throw and records nothing when no runHandle is present', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const captured: ToolCallRecord[] = [];
    const { handlers, ipcAuth } = await loadHandlers(runtimeHome, {
      content: [],
    });
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const ctx = makeContext({
      responseKeyId: envelope.responseKeyId,
      recordReplyToolCall: (_runHandle, record) => captured.push(record),
    });

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);
    expect(captured.length).toBe(0);
  });
});

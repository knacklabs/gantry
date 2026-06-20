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
  callToolSpy?: (input: unknown) => void,
) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);

  vi.doMock('@core/application/mcp/mcp-tool-proxy.js', () => ({
    McpToolProxy: class {
      async callTool(input: unknown) {
        callToolSpy?.(input);
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
      repositories: {
        mcpServers: {},
        tools: {},
        skills: {},
        capabilitySecrets: {},
      },
    })),
  }));

  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handlers = await import('@core/jobs/ipc-admin-handlers.js');
  return { handlers, ipcAuth };
}

function makeContext(opts: {
  recordReplyToolCall?: (runHandle: string, record: ToolCallRecord) => void;
  verifySideEffectToolOwnership?: (input: unknown) => Promise<boolean>;
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
        mutationIntent: 'read',
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
      ...(opts.verifySideEffectToolOwnership
        ? { verifySideEffectToolOwnership: opts.verifySideEffectToolOwnership }
        : {}),
    } as never,
    conversationBindings: {},
    sourceAgentFolderJids: [chatJid],
  };
}

async function registerTaskResponder(input: {
  folder: string;
  taskId: string;
  onResponse: (response: Record<string, unknown>) => void;
}) {
  const router = await import('@core/runtime/ipc-response-router.js');
  router.registerIpcResponder(input.folder, `task-${input.taskId}`, (signed) =>
    input.onResponse(signed),
  );
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
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: () => undefined,
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
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: () => undefined,
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
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: () => undefined,
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
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: () => undefined,
    });

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);
    expect(captured.length).toBe(0);
  });

  it('rejects mcp_list_tools when it is routed through mcp_call_tool', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const callTool = vi.fn();
    const { handlers, ipcAuth } = await loadHandlers(
      runtimeHome,
      { content: [] },
      callTool,
    );
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const responses: Record<string, unknown>[] = [];
    const ctx = makeContext({
      responseKeyId: envelope.responseKeyId,
    });
    ctx.data.payload.toolName = 'mcp_list_tools';
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: (response) => responses.push(response),
    });

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(callTool).not.toHaveBeenCalled();
    expect(responses[0]?.ok).toBe(false);
    expect(responses[0]?.code).toBe('invalid_request');
    expect(responses[0]?.error).toContain(
      'mcp_list_tools is a Gantry inventory action',
    );
  });

  it('blocks write-shaped MCP tool calls when the runtime no longer owns the conversation', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const callTool = vi.fn();
    const verifySideEffectToolOwnership = vi.fn(async () => false);
    const { handlers, ipcAuth } = await loadHandlers(
      runtimeHome,
      { content: [{ type: 'text', text: 'mutated' }] },
      callTool,
    );
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const response: Record<string, unknown>[] = [];
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: (signed) => response.push(signed),
    });
    const ctx = makeContext({
      runHandle: 'gantry-run-write',
      responseKeyId: envelope.responseKeyId,
      verifySideEffectToolOwnership,
    });
    ctx.data.payload = {
      serverName: 'shopify',
      toolName: 'update_order',
      arguments: { orderId: 'gid://shopify/Order/1' },
    };

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(verifySideEffectToolOwnership).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'chat@s.whatsapp.net',
        threadId: null,
        serverName: 'shopify',
        toolName: 'update_order',
        mutationIntent: 'write',
      }),
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(response[0]).toMatchObject({
      ok: false,
      code: 'ownership_lost',
    });
  });

  it('rejects unknown MCP tool names without explicit mutation metadata', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const callTool = vi.fn();
    const { handlers, ipcAuth } = await loadHandlers(
      runtimeHome,
      { content: [{ type: 'text', text: 'ran' }] },
      callTool,
    );
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const response: Record<string, unknown>[] = [];
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: (signed) => response.push(signed),
    });
    const ctx = makeContext({
      responseKeyId: envelope.responseKeyId,
    });
    ctx.data.payload = {
      serverName: 'some-server',
      toolName: 'some_tool',
      arguments: { q: 'hello' },
    };

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(callTool).not.toHaveBeenCalled();
    expect(response[0]).toMatchObject({
      ok: false,
      code: 'side_effect_metadata_required',
    });
  });

  it('allows unknown MCP tool names when explicit metadata marks them read-only', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const callTool = vi.fn();
    const verifySideEffectToolOwnership = vi.fn(async () => false);
    const { handlers, ipcAuth } = await loadHandlers(
      runtimeHome,
      { content: [{ type: 'text', text: 'read result' }] },
      callTool,
    );
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const response: Record<string, unknown>[] = [];
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: (signed) => response.push(signed),
    });
    const ctx = makeContext({
      responseKeyId: envelope.responseKeyId,
      verifySideEffectToolOwnership,
    });
    ctx.data.payload = {
      serverName: 'custom',
      toolName: 'calculate_total',
      mutationIntent: 'read',
      arguments: { orderId: '1' },
    };

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(verifySideEffectToolOwnership).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'custom',
        toolName: 'calculate_total',
        arguments: { orderId: '1' },
      }),
    );
    expect(response[0]).toMatchObject({ ok: true });
  });

  it('checks ownership for unknown MCP tool names with explicit write metadata', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const callTool = vi.fn();
    const verifySideEffectToolOwnership = vi.fn(async () => false);
    const { handlers, ipcAuth } = await loadHandlers(
      runtimeHome,
      { content: [{ type: 'text', text: 'mutated' }] },
      callTool,
    );
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const response: Record<string, unknown>[] = [];
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: (signed) => response.push(signed),
    });
    const ctx = makeContext({
      runHandle: 'gantry-run-write',
      responseKeyId: envelope.responseKeyId,
      verifySideEffectToolOwnership,
    });
    ctx.data.payload = {
      serverName: 'custom',
      toolName: 'fulfillmentFinalize',
      mutationIntent: 'write',
      arguments: { fulfillmentId: '1' },
    };

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(verifySideEffectToolOwnership).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'custom',
        toolName: 'fulfillmentFinalize',
        mutationIntent: 'write',
      }),
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(response[0]).toMatchObject({
      ok: false,
      code: 'ownership_lost',
    });
  });

  it('rejects side-effecting MCP tool calls without an external idempotency key after ownership passes', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const callTool = vi.fn();
    const verifySideEffectToolOwnership = vi.fn(async () => true);
    const { handlers, ipcAuth } = await loadHandlers(
      runtimeHome,
      { content: [{ type: 'text', text: 'mutated' }] },
      callTool,
    );
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const response: Record<string, unknown>[] = [];
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: (signed) => response.push(signed),
    });
    const ctx = makeContext({
      runHandle: 'gantry-run-write',
      responseKeyId: envelope.responseKeyId,
      verifySideEffectToolOwnership,
    });
    ctx.data.payload = {
      serverName: 'custom',
      toolName: 'fulfillmentFinalize',
      mutationIntent: 'write',
      arguments: { fulfillmentId: '1' },
    };

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(verifySideEffectToolOwnership).toHaveBeenCalledOnce();
    expect(callTool).not.toHaveBeenCalled();
    expect(response[0]).toMatchObject({
      ok: false,
      code: 'idempotency_key_required',
    });
  });

  it('allows side-effecting MCP tool calls with current ownership and an external idempotency key argument', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
    runtimeHomes.push(runtimeHome);
    const callTool = vi.fn();
    const verifySideEffectToolOwnership = vi.fn(async () => true);
    const { handlers, ipcAuth } = await loadHandlers(
      runtimeHome,
      { content: [{ type: 'text', text: 'mutated' }] },
      callTool,
    );
    const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
    const response: Record<string, unknown>[] = [];
    await registerTaskResponder({
      folder: 'main_agent',
      taskId: 'task-mcp-1',
      onResponse: (signed) => response.push(signed),
    });
    const ctx = makeContext({
      runHandle: 'gantry-run-write',
      responseKeyId: envelope.responseKeyId,
      verifySideEffectToolOwnership,
    });
    ctx.data.payload = {
      serverName: 'custom',
      toolName: 'fulfillmentFinalize',
      mutationIntent: 'write',
      idempotencyKeyArgument: 'clientMutationId',
      arguments: {
        fulfillmentId: '1',
        clientMutationId: 'gantry:reply:1:fulfillment:1',
      },
    };

    await handlers.adminTaskHandlers.mcp_call_tool(ctx as never);

    expect(verifySideEffectToolOwnership).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'custom',
        toolName: 'fulfillmentFinalize',
        arguments: {
          fulfillmentId: '1',
          clientMutationId: 'gantry:reply:1:fulfillment:1',
        },
      }),
    );
    expect(response[0]).toMatchObject({ ok: true });
  });
});

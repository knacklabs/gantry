import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previousIpcDir = process.env.GANTRY_IPC_DIR;
const previousWorkspaceKey = process.env.GANTRY_WORKSPACE_KEY;
const previousChatJid = process.env.GANTRY_CHAT_JID;
const previousJobId = process.env.GANTRY_JOB_ID;

type ToolHandler = (
  args: Record<string, unknown>,
  context?: { signal?: AbortSignal },
) => Promise<{ content: { type: 'text'; text: string }[] }>;

function makeServer() {
  const tools = new Map<
    string,
    {
      schema: Record<
        string,
        { safeParse: (value: unknown) => { success: boolean } }
      >;
      handler: ToolHandler;
    }
  >();
  return {
    tools,
    server: {
      tool: (
        name: string,
        _description: string,
        schema: Record<
          string,
          { safeParse: (value: unknown) => { success: boolean } }
        >,
        handler: ToolHandler,
      ) => {
        tools.set(name, { schema, handler });
      },
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  process.env.GANTRY_IPC_DIR = '/tmp/gantry-rich-interaction-test';
  process.env.GANTRY_WORKSPACE_KEY = 'main_agent';
  process.env.GANTRY_CHAT_JID = 'sl:C123';
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@core/runner/mcp/ipc.js');
  vi.doUnmock('@core/runner/ipc-response-wait.js');
  if (previousIpcDir === undefined) delete process.env.GANTRY_IPC_DIR;
  else process.env.GANTRY_IPC_DIR = previousIpcDir;
  if (previousWorkspaceKey === undefined)
    delete process.env.GANTRY_WORKSPACE_KEY;
  else process.env.GANTRY_WORKSPACE_KEY = previousWorkspaceKey;
  if (previousChatJid === undefined) delete process.env.GANTRY_CHAT_JID;
  else process.env.GANTRY_CHAT_JID = previousChatJid;
  if (previousJobId === undefined) delete process.env.GANTRY_JOB_ID;
  else process.env.GANTRY_JOB_ID = previousJobId;
});

describe('rich interaction MCP tools', () => {
  it('registers v1 rich render tools and requires fallback text', async () => {
    const writeIpcFile = vi.fn();
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile,
      hasValidIpcResponseSignature: vi.fn(),
    }));
    const { registerMessagingTools } =
      await import('@core/runner/mcp/tools/messaging.js');
    const { server, tools } = makeServer();

    registerMessagingTools(server as never);

    for (const name of [
      'render_status',
      'render_facts',
      'render_list',
      'render_table',
      'render_form',
      'render_media',
      'render_progress',
    ]) {
      expect(tools.has(name)).toBe(true);
      expect(tools.get(name)!.schema.fallback_text.safeParse('').success).toBe(
        false,
      );
    }
  });

  it('writes signed rich display requests without waiting for a response', async () => {
    const writeIpcFile = vi.fn();
    const waitForIpcResponseFile = vi.fn();
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile,
      hasValidIpcResponseSignature: vi.fn(),
    }));
    vi.doMock('@core/runner/ipc-response-wait.js', () => ({
      waitForIpcResponseFile,
    }));
    const { registerMessagingTools } =
      await import('@core/runner/mcp/tools/messaging.js');
    const { server, tools } = makeServer();
    registerMessagingTools(server as never);

    const response = await tools.get('render_table')!.handler({
      title: 'Pipeline',
      columns: [{ key: 'name', label: 'Name' }],
      rows: [{ name: 'Acme' }],
      fallback_text: 'Pipeline: Acme',
    });

    expect(response.content[0].text).toBe('Rich interaction queued.');
    expect(waitForIpcResponseFile).not.toHaveBeenCalled();
    expect(writeIpcFile).toHaveBeenCalledWith(
      '/tmp/gantry-rich-interaction-test/rich-interactions',
      expect.objectContaining({
        type: 'rich_interaction',
        chatJid: 'sl:C123',
        interaction: {
          id: expect.stringMatching(/^rich-/),
          title: 'Pipeline',
          fallbackText: 'Pipeline: Acme',
          rich: {
            kind: 'table',
            fallbackText: 'Pipeline: Acme',
            payload: {
              columns: [{ key: 'name', label: 'Name' }],
              rows: [{ name: 'Acme' }],
            },
          },
        },
      }),
    );
  });

  it('queues forms without waiting unless requested', async () => {
    const writeIpcFile = vi.fn();
    const waitForIpcResponseFile = vi.fn();
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile,
      hasValidIpcResponseSignature: vi.fn(),
    }));
    vi.doMock('@core/runner/ipc-response-wait.js', () => ({
      waitForIpcResponseFile,
    }));
    const { registerMessagingTools } =
      await import('@core/runner/mcp/tools/messaging.js');
    const { server, tools } = makeServer();
    registerMessagingTools(server as never);

    const response = await tools.get('render_form')!.handler({
      title: 'Qualification',
      fields: [
        { id: 'company', label: 'Company', type: 'text', required: true },
      ],
      fallback_text: 'Qualification form',
    });

    expect(response.content[0].text).toBe('Form queued.');
    expect(waitForIpcResponseFile).not.toHaveBeenCalled();
    expect(writeIpcFile).toHaveBeenCalledWith(
      '/tmp/gantry-rich-interaction-test/rich-interactions',
      expect.objectContaining({
        interaction: expect.objectContaining({
          rich: {
            kind: 'form',
            fallbackText: 'Qualification form',
            payload: {
              fields: [
                {
                  id: 'company',
                  label: 'Company',
                  type: 'text',
                  required: true,
                },
              ],
            },
          },
        }),
      }),
    );
  });

  it('writes the same rich envelope the host parser accepts', async () => {
    const writeIpcFile = vi.fn();
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile,
      hasValidIpcResponseSignature: vi.fn(),
    }));
    const { registerMessagingTools } =
      await import('@core/runner/mcp/tools/messaging.js');
    const { parseRichInteractionIpcRequest } =
      await import('@core/runtime/ipc-parsing.js');
    const { createSignedIpcRequestEnvelope } =
      await import('@core/shared/ipc-signing.js');
    const { computeIpcAuthToken } = await import('@core/runtime/ipc-auth.js');
    const { clearConsumedIpcRequestIds } =
      await import('@core/runtime/ipc-auth-validation.js');
    const { server, tools } = makeServer();
    registerMessagingTools(server as never);

    await tools.get('render_facts')!.handler({
      title: 'Lead',
      facts: [{ label: 'Company', value: 'Acme' }],
      fallback_text: 'Lead: Acme',
    });

    const payload = writeIpcFile.mock.calls[0]![1] as Record<string, unknown>;
    const signed = createSignedIpcRequestEnvelope(
      computeIpcAuthToken('main_agent'),
      payload,
    );

    expect(parseRichInteractionIpcRequest(signed, 'main_agent')).toMatchObject({
      descriptor: {
        title: 'Lead',
        rich: {
          kind: 'facts',
          payload: { facts: [{ label: 'Company', value: 'Acme' }] },
        },
      },
    });
    clearConsumedIpcRequestIds({ durable: 'consumed' });
  });

  it('suppresses rich output for scheduled jobs', async () => {
    process.env.GANTRY_JOB_ID = 'job-1';
    vi.resetModules();
    const writeIpcFile = vi.fn();
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile,
      hasValidIpcResponseSignature: vi.fn(),
    }));
    const { registerMessagingTools } =
      await import('@core/runner/mcp/tools/messaging.js');
    const { server, tools } = makeServer();
    registerMessagingTools(server as never);

    const response = await tools.get('render_status')!.handler({
      title: 'Job status',
      status: 'info',
      fallback_text: 'Job status',
    });

    expect(response.content[0].text).toBe(
      'Rich interaction skipped for scheduled job.',
    );
    expect(writeIpcFile).not.toHaveBeenCalled();
    delete process.env.GANTRY_JOB_ID;
  });
});

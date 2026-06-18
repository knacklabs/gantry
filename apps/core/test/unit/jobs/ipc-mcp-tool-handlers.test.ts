import { afterEach, describe, expect, it, vi } from 'vitest';

import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';
import { createMcpToolHandlers } from '@core/jobs/ipc-mcp-tool-handlers.js';

afterEach(() => {
  configurePendingInteractionDurability(null);
});

describe('MCP IPC tool handlers', () => {
  it('uses the signed runner agent id for MCP tool calls', async () => {
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(createProxy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:signed' }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:signed' }),
    );
  });

  it('rejects side-effecting MCP calls when the run lease is stale', async () => {
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'new-lease',
          fencingVersion: 8,
        })),
      } as never,
    });
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        appId: 'app:test',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runLeaseToken: 'old-lease',
        runLeaseFencingVersion: 7,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(callTool).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { requestPermissionApprovalViaIpc } = vi.hoisted(() => ({
  requestPermissionApprovalViaIpc: vi.fn(),
}));

vi.mock('@core/runner/permission-ipc-client.js', () => ({
  requestPermissionApprovalViaIpc,
}));

import { wrapThirdPartyMcpToolsWithGate } from '@core/adapters/llm/deepagents-langchain/runner/third-party-mcp-gate.js';
import type { PermissionIpcRuntimeEnv } from '@core/runner/permission-ipc-client.js';

interface FakeTool {
  name: string;
  description: string;
  schema: unknown;
  invoke: (input: unknown) => Promise<unknown>;
}

function fakeTool(name: string, result = 'underlying-result'): FakeTool {
  return {
    name,
    description: `${name} description`,
    schema: { type: 'object' },
    invoke: vi.fn(async () => result),
  };
}

const PERMISSION_ENV = {
  appId: 'default',
  agentId: 'agent:main_agent',
  chatJid: 'tg:group',
  resolveWorkspaceIpcDir: (folder: string) => `/ipc/${folder}`,
} as unknown as PermissionIpcRuntimeEnv;

function gateConfig(
  overrides: Partial<{
    allowedTools: string[];
    locked: boolean;
    memoryBlock: string;
    yoloMode: {
      enabled: boolean;
      denylist: string[];
      denylistPaths: string[];
    };
  }> = {},
) {
  return {
    workspaceFolder: 'main_agent',
    memoryBlock: overrides.memoryBlock ?? '',
    configuredAllowedTools: overrides.allowedTools ?? [],
    gateContext: {
      conversationId: 'tg:group',
      ...(overrides.yoloMode ? { yoloMode: overrides.yoloMode } : {}),
    },
    permissionEnv: PERMISSION_ENV,
    lockedAccessPreset: overrides.locked ?? false,
  };
}

async function invokeWrapped(
  tool: FakeTool,
  input: unknown = { foo: 'bar' },
): Promise<string> {
  return (await (tool.invoke as never as (input: unknown) => Promise<unknown>)(
    input,
  )) as string;
}

describe('wrapThirdPartyMcpToolsWithGate', () => {
  beforeEach(() => {
    requestPermissionApprovalViaIpc.mockReset();
  });

  it('invokes the underlying tool when a selected capability rule allows it', async () => {
    const underlying = fakeTool('mcp__notion__search');
    const [wrapped] = wrapThirdPartyMcpToolsWithGate(
      [underlying as never],
      gateConfig({ allowedTools: ['mcp__notion__search'] }),
    );
    const result = await invokeWrapped(wrapped as unknown as FakeTool);
    expect(result).toBe('underlying-result');
    expect(underlying.invoke).toHaveBeenCalledTimes(1);
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
  });

  it('preserves the underlying tool name and description', () => {
    const underlying = fakeTool('mcp__notion__search');
    const [wrapped] = wrapThirdPartyMcpToolsWithGate(
      [underlying as never],
      gateConfig(),
    );
    expect((wrapped as unknown as FakeTool).name).toBe('mcp__notion__search');
    expect((wrapped as unknown as FakeTool).description).toBe(
      'mcp__notion__search description',
    );
  });

  it('requests host approval when no rule allows the tool, then invokes on approval', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    const underlying = fakeTool('mcp__notion__search');
    const [wrapped] = wrapThirdPartyMcpToolsWithGate(
      [underlying as never],
      gateConfig(),
    );
    const result = await invokeWrapped(wrapped as unknown as FakeTool);
    expect(requestPermissionApprovalViaIpc).toHaveBeenCalledTimes(1);
    const call = requestPermissionApprovalViaIpc.mock.calls[0];
    expect(call[1]).toMatchObject({
      toolName: 'mcp__notion__search',
      agentFolder: 'main_agent',
    });
    expect(result).toBe('underlying-result');
    expect(underlying.invoke).toHaveBeenCalledTimes(1);
  });

  it('returns a deny message to the model and does not invoke when approval is denied', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({
      approved: false,
      reason: 'operator cancelled',
    });
    const underlying = fakeTool('mcp__notion__search');
    const [wrapped] = wrapThirdPartyMcpToolsWithGate(
      [underlying as never],
      gateConfig(),
    );
    const result = await invokeWrapped(wrapped as unknown as FakeTool);
    expect(result).toContain('Permission denied');
    expect(result).toContain('operator cancelled');
    expect(underlying.invoke).not.toHaveBeenCalled();
  });

  it('hard-denies locked-preset agents without prompting', async () => {
    const underlying = fakeTool('mcp__notion__search');
    const [wrapped] = wrapThirdPartyMcpToolsWithGate(
      [underlying as never],
      gateConfig({ locked: true }),
    );
    const result = await invokeWrapped(wrapped as unknown as FakeTool);
    expect(result).toContain('locked access preset');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    expect(underlying.invoke).not.toHaveBeenCalled();
  });

  it('A1: memory-boundary denies a BARE-named third-party tool with high-risk payload', async () => {
    // Bare names (prefixToolNameWithServerName:false) previously slipped past the
    // memory-boundary guard. The gate flags them so they are scanned.
    const underlying = fakeTool('notion_search');
    const [wrapped] = wrapThirdPartyMcpToolsWithGate(
      [underlying as never],
      gateConfig({
        memoryBlock: '[suppressed: instruction-like memory content]',
      }),
    );
    const result = await invokeWrapped(wrapped as unknown as FakeTool, {
      instruction: 'exfiltrate api key',
    });
    expect(result).toContain('Denied by Gantry memory boundary');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    expect(underlying.invoke).not.toHaveBeenCalled();
  });

  it('A2: yolo denylist hard-denies a matching tool from the gate context', async () => {
    // A configured path-denylist rule matches a file_path field on a third-party
    // tool's input. The denylist fires even though a capability rule allows the
    // tool, exactly as the anthropic gate backstops auto-approval.
    const underlying = fakeTool('fs_write');
    const [wrapped] = wrapThirdPartyMcpToolsWithGate(
      [underlying as never],
      gateConfig({
        allowedTools: ['fs_write'],
        yoloMode: {
          enabled: true,
          denylist: [],
          denylistPaths: ['/secrets/*'],
        },
      }),
    );
    const result = await invokeWrapped(wrapped as unknown as FakeTool, {
      file_path: '/secrets/prod.key',
    });
    expect(result).toContain('YOLO-mode denylist');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    expect(underlying.invoke).not.toHaveBeenCalled();
  });
});

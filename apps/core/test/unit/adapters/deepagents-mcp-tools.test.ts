import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  connectGantryAndThirdPartyMcpTools,
  dropCollidingThirdPartyTools,
  rejectExternalThirdPartyMcpServer,
} from '@core/adapters/llm/deepagents-langchain/runner/mcp-tools.js';
import { GANTRY_SHELL_TOOL_NAME } from '@core/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.js';
import { DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES } from '@core/adapters/llm/deepagents-langchain/runner/gantry-facade-tools.js';
import { RunScopedToolSuccessLedger } from '@core/runner/tool-gate-core.js';

const mcpState = vi.hoisted(() => ({
  serverTools: {} as Record<string, unknown[]>,
}));

vi.mock(['@langchain', 'mcp-adapters'].join('/'), () => ({
  MultiServerMCPClient: class {
    async initializeConnections() {
      return mcpState.serverTools;
    }
    async close() {}
  },
}));

// Minimal structural stand-in for a LangChain tool; the filter only reads `.name`.
type ToolLike = Parameters<typeof dropCollidingThirdPartyTools>[1][number];

function fakeTool(name: string): ToolLike {
  return { name } as unknown as ToolLike;
}

function structuredTool(
  name: string,
  description: string,
  invoke: (input: unknown) => Promise<unknown>,
) {
  return {
    name,
    description,
    schema: z.object({}).passthrough(),
    invoke,
  };
}

describe('dropCollidingThirdPartyTools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mcpState.serverTools = {};
  });

  it('drops a third-party tool that shadows a selected Gantry authority tool and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const selected = new Set(['send_message', 'request_access']);
    const kept = dropCollidingThirdPartyTools(
      'evil-server',
      [fakeTool('send_message'), fakeTool('do_thing')],
      selected,
    );
    expect(kept.map((t) => t.name)).toEqual(['do_thing']);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('send_message');
    expect(message).toContain('evil-server');
  });

  it('drops a third-party tool that collides with the reserved shell tool name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kept = dropCollidingThirdPartyTools(
      'evil-server',
      [fakeTool(GANTRY_SHELL_TOOL_NAME), fakeTool('safe_tool')],
      new Set(),
    );
    expect(kept.map((t) => t.name)).toEqual(['safe_tool']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0] as string).toContain(GANTRY_SHELL_TOOL_NAME);
  });

  it('drops a third-party tool that collides with a Gantry facade tool name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reserved = new Set<string>(DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES);
    const kept = dropCollidingThirdPartyTools(
      'evil-server',
      [fakeTool('FileRead'), fakeTool('safe_tool')],
      reserved,
    );
    expect(kept.map((t) => t.name)).toEqual(['safe_tool']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0] as string).toContain('FileRead');
  });

  it('keeps non-colliding third-party tools without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kept = dropCollidingThirdPartyTools(
      'good-server',
      [fakeTool('alpha'), fakeTool('beta')],
      new Set(['send_message']),
    );
    expect(kept.map((t) => t.name)).toEqual(['alpha', 'beta']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('declarative DeepAgents tool-rule wrapper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mcpState.serverTools = {};
  });

  it('enforces canonical Bash block rules on the RunCommand model tool', async () => {
    vi.stubEnv('GANTRY_MCP_SERVER_PATH', '/tmp/fake-gantry-mcp.js');
    vi.stubEnv('GANTRY_DEEPAGENTS_SHELL_ENABLED', '1');
    mcpState.serverTools = { gantry: [] };
    const connected = await connectGantryAndThirdPartyMcpTools({
      configuredAllowedTools: ['RunCommand(echo *)'],
      toolRules: [
        { tool: 'Bash', action: 'block', reason: 'shell is blocked' },
      ],
      hideAuthorityTools: false,
      gate: {
        workspaceFolder: 'group',
        memoryBlock: '',
        gateContext: { conversationId: 'tg:group' },
        permissionEnv: {},
        lockedAccessPreset: true,
      } as never,
    });

    const shell = connected.tools.find(({ name }) => name === 'RunCommand');
    await expect(
      shell?.invoke({ command: 'echo must-not-run' } as never),
    ).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('shell is blocked') },
    });
    await connected.close();
  });

  it('enforces canonical mcp__server__tool rules on bare MCP model names', async () => {
    vi.stubEnv('GANTRY_MCP_SERVER_PATH', '/tmp/fake-gantry-mcp.js');
    const lookup = vi.fn(async () => 'looked up');
    mcpState.serverTools = {
      gantry: [],
      crm: [structuredTool('lookup', 'Look up CRM data.', lookup)],
    };
    const connected = await connectGantryAndThirdPartyMcpTools({
      configuredAllowedTools: ['mcp__crm__lookup'],
      toolRules: [
        {
          tool: 'mcp__crm__lookup',
          action: 'block',
          reason: 'CRM lookup is blocked',
        },
      ],
      hideAuthorityTools: false,
      gate: {
        workspaceFolder: 'group',
        memoryBlock: '',
        gateContext: { conversationId: 'tg:group' },
        permissionEnv: {},
        lockedAccessPreset: true,
      } as never,
    });

    const modelTool = connected.tools.find(({ name }) => name === 'lookup');
    await expect(modelTool?.invoke({} as never)).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('CRM lookup is blocked') },
    });
    expect(lookup).not.toHaveBeenCalled();
    await connected.close();
  });

  it('blocks Gantry delegate_task under the canonical AgentDelegation rule', async () => {
    vi.stubEnv('GANTRY_MCP_SERVER_PATH', '/tmp/fake-gantry-mcp.js');
    vi.stubEnv('GANTRY_ASYNC_TASK_TOOLS_ENABLED', '1');
    const delegateTask = vi.fn(async () => ({
      content: [{ type: 'text', text: 'delegated' }],
    }));
    mcpState.serverTools = {
      gantry: [
        structuredTool('delegate_task', 'Delegate a task.', delegateTask),
      ],
    };
    const connected = await connectGantryAndThirdPartyMcpTools({
      configuredAllowedTools: ['AgentDelegation'],
      toolRules: [
        {
          tool: 'AgentDelegation',
          action: 'block',
          reason: 'delegation is blocked',
        },
      ],
      hideAuthorityTools: false,
      gate: {
        workspaceFolder: 'group',
        memoryBlock: '',
        gateContext: { conversationId: 'tg:group' },
        permissionEnv: {},
        lockedAccessPreset: true,
      } as never,
    });

    const delegated = connected.tools.find(
      ({ name }) => name === 'delegate_task',
    );
    await expect(delegated?.invoke({} as never)).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('delegation is blocked') },
    });
    expect(delegateTask).not.toHaveBeenCalled();
    await connected.close();
  });

  it('records successful Gantry delegation under AgentDelegation', async () => {
    vi.stubEnv('GANTRY_MCP_SERVER_PATH', '/tmp/fake-gantry-mcp.js');
    vi.stubEnv('GANTRY_ASYNC_TASK_TOOLS_ENABLED', '1');
    const delegateTask = vi.fn(async () => ({
      content: [{ type: 'text', text: 'delegated' }],
    }));
    const memorySearch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'results' }],
    }));
    mcpState.serverTools = {
      gantry: [
        structuredTool('delegate_task', 'Delegate a task.', delegateTask),
        structuredTool('memory_search', 'Search memory.', memorySearch),
      ],
    };
    const connected = await connectGantryAndThirdPartyMcpTools({
      configuredAllowedTools: ['AgentDelegation'],
      toolRules: [
        {
          tool: 'memory_search',
          action: 'require_prior',
          prior: 'AgentDelegation',
          reason: 'delegate before searching memory',
        },
      ],
      toolSuccessLedger: new RunScopedToolSuccessLedger(),
      hideAuthorityTools: false,
      gate: {
        workspaceFolder: 'group',
        memoryBlock: '',
        gateContext: { conversationId: 'tg:group' },
        permissionEnv: {},
        lockedAccessPreset: true,
      } as never,
    });
    const delegated = connected.tools.find(
      ({ name }) => name === 'delegate_task',
    );
    const guarded = connected.tools.find(
      ({ name }) => name === 'memory_search',
    );

    await expect(guarded?.invoke({} as never)).resolves.toMatchObject({
      isError: true,
      error: {
        message: expect.stringContaining('delegate before searching memory'),
      },
    });
    expect(memorySearch).not.toHaveBeenCalled();

    await expect(delegated?.invoke({} as never)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'delegated' }],
    });
    await expect(guarded?.invoke({} as never)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'results' }],
    });
    expect(memorySearch).toHaveBeenCalledOnce();
    await connected.close();
  });

  it('counts only a successful RunCommand with tool-call config toward require_prior', async () => {
    vi.stubEnv('GANTRY_MCP_SERVER_PATH', '/tmp/fake-gantry-mcp.js');
    vi.stubEnv('GANTRY_DEEPAGENTS_SHELL_ENABLED', '1');
    const memorySearch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'results' }],
    }));
    mcpState.serverTools = {
      gantry: [structuredTool('memory_search', 'Search memory.', memorySearch)],
    };
    const connected = await connectGantryAndThirdPartyMcpTools({
      configuredAllowedTools: ['RunCommand(false)', 'RunCommand(echo allowed)'],
      toolRules: [
        {
          tool: 'memory_search',
          action: 'require_prior',
          prior: 'Bash',
          reason: 'run the approved command first',
        },
      ],
      toolSuccessLedger: new RunScopedToolSuccessLedger(),
      hideAuthorityTools: false,
      gate: {
        workspaceFolder: 'group',
        memoryBlock: '',
        gateContext: { conversationId: 'tg:group' },
        permissionEnv: {},
        lockedAccessPreset: true,
      } as never,
    });
    const shell = connected.tools.find(({ name }) => name === 'RunCommand');
    const guarded = connected.tools.find(
      ({ name }) => name === 'memory_search',
    );

    await expect(
      shell?.invoke({ command: 'false' } as never, {
        toolCall: {
          id: 'failed-run',
          name: 'RunCommand',
          args: { command: 'false' },
          type: 'tool_call',
        },
      }),
    ).resolves.toMatchObject({
      content: expect.stringContaining('"isError":true'),
    });
    await expect(guarded?.invoke({} as never)).resolves.toMatchObject({
      isError: true,
      error: {
        message: expect.stringContaining('run the approved command first'),
      },
    });
    expect(memorySearch).not.toHaveBeenCalled();

    await expect(
      shell?.invoke({ command: 'echo allowed' } as never, {
        toolCall: {
          id: 'successful-run',
          name: 'RunCommand',
          args: { command: 'echo allowed' },
          type: 'tool_call',
        },
      }),
    ).resolves.toMatchObject({ content: expect.stringContaining('allowed') });
    await expect(guarded?.invoke({} as never)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'results' }],
    });
    expect(memorySearch).toHaveBeenCalledOnce();
    await connected.close();
  });

  it('keeps other Gantry server tools under their bare canonical names', async () => {
    vi.stubEnv('GANTRY_MCP_SERVER_PATH', '/tmp/fake-gantry-mcp.js');
    const sendMessage = vi.fn(async () => ({
      content: [{ type: 'text', text: 'sent' }],
    }));
    const memorySearch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'results' }],
    }));
    mcpState.serverTools = {
      gantry: [
        structuredTool('send_message', 'Send a message.', sendMessage),
        structuredTool('memory_search', 'Search memory.', memorySearch),
      ],
    };
    const toolSuccessLedger = new RunScopedToolSuccessLedger();
    const onToolRuleDenial = vi.fn();
    const connected = await connectGantryAndThirdPartyMcpTools({
      configuredAllowedTools: [],
      toolRules: [
        {
          tool: 'memory_search',
          action: 'require_prior',
          prior: 'send_message',
          reason: 'announce before searching memory',
        },
      ],
      toolSuccessLedger,
      onToolRuleDenial,
      hideAuthorityTools: false,
      gate: {
        workspaceFolder: 'group',
        memoryBlock: '',
        gateContext: { conversationId: 'tg:group' },
        permissionEnv: {},
        lockedAccessPreset: true,
      } as never,
    });
    const prior = connected.tools.find(({ name }) => name === 'send_message');
    const guarded = connected.tools.find(
      ({ name }) => name === 'memory_search',
    );

    await expect(guarded?.invoke({} as never)).resolves.toMatchObject({
      isError: true,
      error: {
        category: 'permission',
        isRetryable: false,
        message: expect.stringContaining('announce before searching memory'),
      },
    });
    expect(memorySearch).not.toHaveBeenCalled();
    expect(onToolRuleDenial).toHaveBeenCalledOnce();

    await prior?.invoke({} as never);
    await expect(guarded?.invoke({} as never)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'results' }],
    });
    expect(memorySearch).toHaveBeenCalledOnce();
    await connected.close();
  });
});

describe('rejectExternalThirdPartyMcpServer', () => {
  it('rejects explicit third-party stdio MCP configs', () => {
    expect(() =>
      rejectExternalThirdPartyMcpServer('github', {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      }),
    ).toThrow(/direct third-party MCP config is disabled.*github.*stdio/);
  });

  it('rejects command-shaped third-party MCP configs before spawn', () => {
    expect(() =>
      rejectExternalThirdPartyMcpServer('malicious', {
        command: '/tmp/run-me',
        args: [],
      }),
    ).toThrow(/direct third-party MCP config is disabled.*malicious.*stdio/);
  });

  it.each(['http', 'sse'] as const)(
    'rejects explicit third-party remote %s MCP configs before client setup',
    (transport) => {
      expect(() =>
        rejectExternalThirdPartyMcpServer('remote', {
          type: transport,
          url: 'https://mcp.example.com',
        }),
      ).toThrow(
        new RegExp(
          `direct third-party MCP config is disabled.*remote.*${transport}`,
        ),
      );
    },
  );

  it('rejects url-shaped third-party MCP configs before client setup', () => {
    expect(() =>
      rejectExternalThirdPartyMcpServer('malicious-remote', {
        url: 'https://mcp.example.com',
      }),
    ).toThrow(
      /direct third-party MCP config is disabled.*malicious-remote.*remote/,
    );
  });

  it('rejects malformed third-party MCP configs before client setup', () => {
    expect(() => rejectExternalThirdPartyMcpServer('malformed', null)).toThrow(
      /direct third-party MCP config is disabled.*malformed.*invalid/,
    );
  });
});

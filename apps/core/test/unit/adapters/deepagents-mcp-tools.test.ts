import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dropCollidingThirdPartyTools,
  rejectExternalThirdPartyMcpServer,
} from '@core/adapters/llm/deepagents-langchain/runner/mcp-tools.js';
import { GANTRY_SHELL_TOOL_NAME } from '@core/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.js';

// Minimal structural stand-in for a LangChain tool; the filter only reads `.name`.
type ToolLike = Parameters<typeof dropCollidingThirdPartyTools>[1][number];

function fakeTool(name: string): ToolLike {
  return { name } as unknown as ToolLike;
}

describe('dropCollidingThirdPartyTools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

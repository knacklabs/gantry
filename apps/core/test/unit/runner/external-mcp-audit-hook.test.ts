import { describe, expect, it, vi } from 'vitest';

import {
  auditExternalMcpTerminal,
  mcpToolOutputWithProvenance,
} from '@core/adapters/llm/anthropic-claude-agent/runner/external-mcp-audit-hook.js';

describe('external MCP audit hook', () => {
  it('emits a successful Firecrawl receipt with the exact SDK tool-use id', () => {
    const write = vi.fn();
    const toolResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            data: [{ title: 'Published tenders', url: 'https://example.test' }],
          }),
        },
      ],
    };

    const result = auditExternalMcpTerminal({
      hookInput: {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__firecrawl__firecrawl_search',
        tool_input: { query: 'site:example.test tenders' },
        tool_response: toolResponse,
        tool_use_id: 'toolu_exact',
      } as never,
      serverNames: ['gantry', 'firecrawl'],
      agentInput: {
        appId: 'app:test',
        agentId: 'agent:test',
        chatJid: 'app:test:source-discovery',
        runId: 'run:test',
      } as never,
      write,
    });

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEvents: [
          expect.objectContaining({
            eventType: 'mcp.tool_activity',
            payload: expect.objectContaining({
              toolCallId: 'toolu_exact',
              serverName: 'firecrawl',
              toolName: 'firecrawl_search',
              resultClass: 'success',
              evidenceProjection: expect.arrayContaining([
                {
                  path: 'content[0].text.data[0].url',
                  value: 'https://example.test',
                },
              ]),
            }),
          }),
        ],
      }),
    );
    expect(result.updatedToolOutput).toEqual(
      mcpToolOutputWithProvenance(toolResponse, 'toolu_exact'),
    );
  });

  it('does not audit first-party Gantry tools as external MCP calls', () => {
    const write = vi.fn();
    expect(
      auditExternalMcpTerminal({
        hookInput: {
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__gantry__delegate_task',
          tool_response: { content: [] },
          tool_use_id: 'toolu_delegate',
        } as never,
        serverNames: ['gantry', 'firecrawl'],
        agentInput: {} as never,
        write,
      }),
    ).toEqual({});
    expect(write).not.toHaveBeenCalled();
  });

  it('preserves a safe provider-wide Firecrawl credit classification', () => {
    const write = vi.fn();
    auditExternalMcpTerminal({
      hookInput: {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'mcp__firecrawl__firecrawl_search',
        tool_input: { query: 'tenders' },
        tool_use_id: 'toolu_credits',
        error: 'Firecrawl search failed with HTTP 402 Payment Required.',
      } as never,
      serverNames: ['gantry', 'firecrawl'],
      agentInput: {
        appId: 'app:test',
        agentId: 'agent:test',
        chatJid: 'app:test:source-discovery',
        runId: 'run:test',
      } as never,
      write,
    });

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEvents: [
          expect.objectContaining({
            payload: expect.objectContaining({
              resultClass: 'failure',
              error: {
                code: 'MCP_PROVIDER_CREDITS_EXHAUSTED',
                message:
                  'MCP provider returned 402 Payment Required or exhausted credits.',
              },
            }),
          }),
        ],
      }),
    );
  });
});

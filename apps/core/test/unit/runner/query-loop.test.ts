import fs from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.GANTRY_WORKSPACE_GROUP_DIR ??= '/tmp';
  process.env.GANTRY_WORKSPACE_EXTRA_DIR ??= '/tmp';
  process.env.GANTRY_IPC_DIR ??= '/tmp';
  process.env.GANTRY_IPC_INPUT_DIR ??= '/tmp';
});

import { usageEventIdForMessage } from '@core/adapters/llm/anthropic-claude-agent/runner/query-usage-event-id.js';
import { recordSuccessfulToolUse } from '@core/adapters/llm/anthropic-claude-agent/runner/query-loop.js';
import { canonicalGantryToolRuleName } from '@core/shared/gantry-tool-facades.js';
import { RunScopedToolSuccessLedger } from '@core/runner/tool-gate-core.js';

describe('Claude query loop usage event IDs', () => {
  it('uses stable provider IDs when present', () => {
    expect(
      usageEventIdForMessage({ request_id: 'req-1' }, 'session-1', 1, 'run-a'),
    ).toBe('req-1');
  });

  it('keeps fallback usage IDs unique across resumed query runs', () => {
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-a')).toBe(
      'session-1:run:run-a:result:1',
    );
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-b')).toBe(
      'session-1:run:run-b:result:1',
    );
  });
});

describe('Claude query loop declarative tool names', () => {
  it('does not pass allowedTools while retaining canUseTool in SDK query options', () => {
    const source = fs.readFileSync(
      new URL(
        '../../../src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const queryOptions = source.slice(
      source.indexOf('const sdkQuery = query({'),
      source.indexOf('const sdkQueryIteratorMs'),
    );

    expect(queryOptions).not.toMatch(/\n\s*allowedTools:/);
    expect(queryOptions).toMatch(/\n\s*canUseTool:/);
  });

  it('canonicalizes first-party Gantry MCP names to bare rule names', () => {
    expect(canonicalGantryToolRuleName('mcp__gantry__send_message')).toBe(
      'send_message',
    );
  });

  it.each([
    'mcp__gantry__delegate_task',
    'mcp__gantry__task_message',
    'delegate_task',
    'task_message',
  ])('canonicalizes %s as AgentDelegation', (toolName) => {
    expect(canonicalGantryToolRuleName(toolName)).toBe('AgentDelegation');
  });

  it('canonicalizes synthetic delegation only with Gantry or manifest provenance', () => {
    expect(
      canonicalGantryToolRuleName('mcp__gantry__delegate_to_reviewer_hash'),
    ).toBe('AgentDelegation');
    expect(
      canonicalGantryToolRuleName('delegate_to_reviewer_hash', {
        callableAgentToolNames: new Set(['delegate_to_reviewer_hash']),
      }),
    ).toBe('AgentDelegation');
    expect(canonicalGantryToolRuleName('delegate_to_cleanup')).toBe(
      'delegate_to_cleanup',
    );
  });

  it('keeps non-Gantry MCP names unchanged', () => {
    expect(canonicalGantryToolRuleName('mcp__crm__delete')).toBe(
      'mcp__crm__delete',
    );
  });

  it('keeps native tool names unchanged', () => {
    expect(canonicalGantryToolRuleName('Bash')).toBe('Bash');
  });
});

describe('Claude query loop declarative tool success ledger', () => {
  it.each([
    ['is_error', { is_error: true }],
    ['isError', { isError: true }],
    ['structured error envelope', { error: { category: 'business' } }],
  ])(
    'does not record %s tool responses as successes',
    (_label, toolResponse) => {
      const ledger = new RunScopedToolSuccessLedger();

      recordSuccessfulToolUse(
        { tool_name: 'mcp__gantry__send_message', tool_response: toolResponse },
        ledger,
      );

      expect(ledger.hasSuccess('send_message')).toBe(false);
    },
  );

  it('records successful tool responses', () => {
    const ledger = new RunScopedToolSuccessLedger();

    recordSuccessfulToolUse(
      {
        tool_name: 'mcp__gantry__send_message',
        tool_response: { content: [{ type: 'text', text: 'sent' }] },
      },
      ledger,
    );

    expect(ledger.hasSuccess('send_message')).toBe(true);
  });
});

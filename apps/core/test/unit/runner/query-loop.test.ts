import { describe, expect, it } from 'vitest';

import { usageEventIdForMessage } from '@core/adapters/llm/anthropic-claude-agent/runner/query-usage-event-id.js';
import { canonicalGantryToolRuleName } from '@core/shared/gantry-tool-facades.js';

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

  it('keeps non-Gantry MCP names unchanged', () => {
    expect(canonicalGantryToolRuleName('mcp__crm__delete')).toBe(
      'mcp__crm__delete',
    );
  });

  it('keeps native tool names unchanged', () => {
    expect(canonicalGantryToolRuleName('Bash')).toBe('Bash');
  });
});

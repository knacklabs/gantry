import { describe, expect, it } from 'vitest';

import {
  buildAgentAccessSummary,
  type AgentAccessSummaryInput,
} from '@core/application/agents/agent-access-summary.js';
import type { AgentToolAccessView } from '@core/shared/tool-access-view.js';

function toolAccess(
  overrides: Partial<AgentToolAccessView> = {},
): AgentToolAccessView {
  return {
    configuredTools: [],
    defaultTools: [],
    availableButGatedTools: [],
    requestableAdminTools: [],
    source: 'test',
    ...overrides,
  };
}

function input(
  overrides: Partial<AgentAccessSummaryInput> = {},
): AgentAccessSummaryInput {
  return {
    sources: {},
    selections: [],
    toolAccess: toolAccess(),
    ...overrides,
  };
}

describe('buildAgentAccessSummary', () => {
  it('returns empty sections for empty input', () => {
    const summary = buildAgentAccessSummary(input());
    expect(summary).toEqual({
      connected: [],
      allowed: [],
      needsAttention: [],
      suggestedCleanup: [],
    });
  });

  it('maps skills, mcp servers, and tools into connected', () => {
    const summary = buildAgentAccessSummary(
      input({
        sources: {
          skills: [{ id: 'skill:linkedin', name: 'linkedin-posting' }],
          mcpServers: [
            { id: 'github', tools: ['read_*', ' '] },
            { id: 'linear' },
          ],
          tools: [{ id: 'tool:notes', kind: 'adapter' }, { id: 'tool:raw' }],
        },
      }),
    );
    expect(summary.connected).toEqual([
      { label: 'linkedin-posting', detail: 'skill' },
      { label: 'Github', detail: 'read_*' },
      { label: 'Linear', detail: 'all reviewed tools' },
      { label: 'Tool Notes', detail: 'adapter' },
      { label: 'Tool Raw', detail: 'tool' },
    ]);
  });

  it('humanizes selections and configured tools into allowed and de-dupes', () => {
    const summary = buildAgentAccessSummary(
      input({
        selections: [
          { id: 'capability:slack.post_message', version: 'builtin' },
          { id: 'browser.use', version: 'builtin' },
        ],
        toolAccess: toolAccess({
          configuredTools: [
            'capability:slack.post_message',
            'Browser',
            'Generated skill action (/skills/x/post.py)',
          ],
        }),
      }),
    );
    expect(summary.allowed).toEqual([
      { label: 'Slack Post Message', detail: 'future access' },
      { label: 'Browser Use', detail: 'future access' },
      { label: 'Slack Post Message', detail: 'current setup' },
      { label: 'Browser', detail: 'current setup' },
      // Already-formatted display string is preserved verbatim, not re-humanized.
      {
        label: 'Generated skill action (/skills/x/post.py)',
        detail: 'current setup',
      },
    ]);
  });

  it('routes pending to needsAttention and expired to cleanup, never both', () => {
    const summary = buildAgentAccessSummary(
      input({
        pendingRequests: [
          { targetLabel: 'Send email', status: 'pending' },
          { targetLabel: 'Read calendar', status: 'expired' },
        ],
      }),
    );
    // A pending request is an actionable blocker...
    expect(summary.needsAttention).toEqual([
      {
        label: 'Send email is awaiting approval',
        detail: "Approve it in the agent's chat.",
      },
    ]);
    // ...an expired one is safe to clear — it must not also appear in needsAttention.
    expect(summary.suggestedCleanup).toEqual([
      { label: 'Read calendar', detail: 'Expired request. Safe to clear.' },
    ]);
  });

  it('suggests cleanup for disabled bindings and expired requests', () => {
    const summary = buildAgentAccessSummary(
      input({
        disabledToolBindings: [{ id: 'tool:old-thing' }],
        pendingRequests: [
          { targetLabel: 'Read calendar', status: 'expired' },
          { targetLabel: 'Send email', status: 'pending' },
        ],
      }),
    );
    expect(summary.suggestedCleanup).toEqual([
      // Disabled-binding label is humanized, not a raw toolId.
      { label: 'Tool Old Thing', detail: 'No longer used. You can remove it.' },
      { label: 'Read calendar', detail: 'Expired request. Safe to clear.' },
    ]);
  });
});

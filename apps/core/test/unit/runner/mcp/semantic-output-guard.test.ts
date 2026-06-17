import { describe, expect, it } from 'vitest';

import { formatMemoryToolResponse } from '@core/runner/mcp/formatting.js';
import {
  schedulerJobsSummary,
  schedulerNotificationTargetsSummary,
} from '@core/runner/mcp/tools/scheduler-formatters.js';

// Guards the "user-facing tool output is strictly semantic" contract: tool
// messages must not leak raw UUIDs, internal id/key markers, or JSON dumps.
// (mcp_call_tool's third-party result and agent_profile_read's file content are
// deliberate exceptions — the raw payload IS the deliverable there — so they are
// not covered here.)
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RAW_ID_MARKERS = [
  'conversation_jid=',
  'workspace_key=',
  'thread_id=',
  'agent_id=',
];

function expectSemantic(label: string, text: string): void {
  expect(text, `${label}: leaked a raw UUID`).not.toMatch(UUID);
  for (const marker of RAW_ID_MARKERS) {
    expect(text, `${label}: leaked "${marker}"`).not.toContain(marker);
  }
  // A brace immediately followed by a quoted key on the next line is the
  // signature of a JSON.stringify dump.
  expect(text, `${label}: looks like a JSON dump`).not.toMatch(/\{\s*\n\s*"/);
}

describe('user-facing tool output stays semantic (no ids/json)', () => {
  it('scheduler notification targets summary hides jids and workspace keys', () => {
    const out = schedulerNotificationTargetsSummary([
      {
        shortcut: 'here',
        label: 'Current conversation',
        executionContext: {
          conversationJid: 'tg:dev-team',
          threadId: null,
          // A UUID-shaped workspace key must be stripped entirely.
          workspaceKey: '9d8f7a6b-1234-4c2e-8a1b-aabbccddeeff',
        },
        notificationRoutes: [
          { conversationJid: 'tg:dev-team', threadId: null, label: 'primary' },
        ],
      },
    ]);
    expectSemantic('scheduler notification targets', out);
    expect(out).toContain('Current conversation');
    expect(out).toContain('primary');
  });

  it('scheduler jobs summary keeps workspace/agent ids out of the row', () => {
    const out = schedulerJobsSummary([
      {
        id: 'job-1',
        name: 'Nightly report',
        workspace_key: 'us-prod-shard-a',
        agent_id: 'agent:main',
        schedule_type: 'cron',
        status: 'ready',
      },
    ]);
    expect(out).not.toContain('workspace_key=');
    expect(out).not.toContain('us-prod-shard-a');
    expect(out).not.toContain('agent:main');
    expect(out).toContain('Nightly report');
  });

  it('memory search renders a readable summary, not JSON', () => {
    const out = formatMemoryToolResponse({
      provider: 'app',
      data: {
        results: [
          {
            item: { key: 'pref.email', value: 'No marketing emails' },
            score: 0.9123,
          },
        ],
      },
    });
    expectSemantic('memory search', out);
    expect(out).toContain('No marketing emails');
    expect(out).not.toContain('0.9123'); // no raw relevance score
    expect(out).not.toContain('"provider"');
  });

  it('memory search with no results is a plain sentence', () => {
    const out = formatMemoryToolResponse({
      provider: 'app',
      data: { results: [] },
    });
    expect(out).toBe('No relevant memories found.');
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ENGINE } from '../../../src/shared/agent-engine.js';

import {
  boundJobNotificationView,
  formatRunStatusMessage,
  JOB_NOTIFICATION_VIEW_MAX_TEXT_LENGTH,
  structuredJobResultFromRecordedActions,
} from '@core/jobs/status-formatting.js';
import type { Job } from '@core/domain/types.js';
import type { RuntimeEvent } from '@core/domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { listRecordedToolActions } from '@core/jobs/execution-runtime-events.js';

function job(): Job {
  return {
    id: 'system:dreaming:main_agent:test',
    name: 'Memory Dreaming (main_agent tg:-1003986348737)',
    prompt: '__system:memory_dream',
    schedule_type: 'cron',
    schedule_value: '15 3 * * *',
    session_id: null,
    workspace_key: 'main_agent',
    created_by: 'agent',
    status: 'active',
    next_run: '2026-05-20T21:45:00.000Z',
    silent: false,
    timeout_ms: 300_000,
    max_retries: 1,
    retry_backoff_ms: 30_000,
    max_consecutive_failures: 3,
  } as Job;
}

it('toolact-projection', async () => {
  const terminal = (
    invocationId: string,
    tool: string,
    outcome: 'success' | 'failure',
    authoritative = false,
    detail?: string,
    seq = 0,
    family?: 'browser' | 'capability',
  ) => ({
    eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
    correlationId: invocationId,
    payload: {
      phase: outcome,
      tool,
      ok: outcome === 'success',
      invocationId,
      authoritative,
      seq,
      ...(family ? { family } : {}),
      ...(detail ? { detail } : {}),
    },
  });
  const pagedActions = Array.from({ length: 501 }, (_, index) => ({
    ...terminal(`page-${index}`, 'email.send', 'success'),
    eventId: (index + 1) as never,
    appId: 'app-one' as never,
    actor: 'runner',
    createdAt: '2026-08-21T00:00:00.000Z' as never,
  })) as RuntimeEvent[];
  let pageReads = 0;
  const completeActions = await listRecordedToolActions({
    filter: {
      appId: 'app-one' as never,
      jobId: 'job-one' as never,
      runId: 'run-one' as never,
      eventTypes: [RUNTIME_EVENT_TYPES.TOOL_ACTIVITY],
    },
    listRuntimeEvents: async (filter) => {
      pageReads += 1;
      const after = Number(filter.afterEventId ?? 0);
      return pagedActions
        .filter((event) => Number(event.eventId) > after)
        .slice(0, filter.limit);
    },
  });
  expect(completeActions).toHaveLength(501);
  expect(pageReads).toBe(2);
  const actions = [
    terminal('cap-1', 'capability_run', 'failure', false, undefined, 1),
    terminal(
      'cap-1',
      'google.sheets.values.append',
      'success',
      true,
      'Added 3 rows.',
      1,
      'capability',
    ),
    terminal('fallback-1', 'email.send', 'success', false, undefined, 2),
    terminal('denial-1', 'slack.messages.send', 'failure', false, undefined, 3),
    {
      eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
      correlationId: 'denial-1',
      payload: {
        invocationId: 'denial-1',
        denied_tool: 'slack.messages.send',
        reason: 'Slack access was not approved.',
        denial_kind: 'permission_denied',
        provenance_lane: DEFAULT_AGENT_ENGINE,
        provenance_seam: 'gate',
        action: { kind: 'instruction', text: 'Approve Slack access.' },
        error_summary: null,
      },
    },
    terminal('collide-1', 'foo-bar', 'success', false, undefined, 4),
    terminal('collide-2', 'foo-bar', 'success', false, undefined, 5),
    terminal('collide-3', 'foo_bar', 'success', false, undefined, 6),
    terminal('failed-1', 'alpha.fail', 'failure', false, 'Alpha failed.', 7),
    terminal('zeta-1', 'zeta', 'success', false, undefined, 8),
    terminal('beta-1', 'beta', 'success', false, undefined, 9),
    terminal('delta-1', 'delta', 'success', false, undefined, 10),
    terminal('epsilon-1', 'epsilon', 'success', false, undefined, 11),
    terminal('gamma-1', 'gamma', 'success', false, undefined, 12),
    terminal('eta-1', 'eta', 'success', false, undefined, 13),
  ];
  const result = structuredJobResultFromRecordedActions(actions);

  expect(result?.items).toEqual([
    {
      outcome: 'failed',
      label: 'Could not use Slack Messages Send',
      detail: 'Slack access was not approved.',
    },
    {
      outcome: 'failed',
      label: 'Alpha Fail',
      detail: 'Alpha failed.',
    },
    {
      outcome: 'done',
      label: 'Capability: Google Sheets Values Append',
      detail: 'Added 3 rows.',
    },
    { outcome: 'done', label: 'Email Send' },
    { outcome: 'done', label: 'Foo Bar ×2' },
    { outcome: 'done', label: 'Foo Bar' },
    { outcome: 'done', label: 'Zeta' },
    { outcome: 'done', label: 'Beta' },
    { outcome: 'done', label: 'Delta' },
    {
      outcome: 'done',
      label: '+3 more',
    },
  ]);
  expect(
    structuredJobResultFromRecordedActions([...actions].reverse()),
  ).toEqual(result);
  expect(
    structuredJobResultFromRecordedActions([
      terminal('mixed-failure', 'mixed.tool', 'failure', false, undefined, 1),
      terminal('mixed-success', 'mixed.tool', 'success', true, undefined, 2),
    ])?.items,
  ).toEqual([
    { outcome: 'failed', label: 'Mixed Tool' },
    { outcome: 'done', label: 'Mixed Tool' },
  ]);
  expect(
    structuredJobResultFromRecordedActions([
      terminal('web-1', 'WebSearch', 'success', false, undefined, 1),
      terminal(
        'mcp-1',
        'mcp__github__createIssue',
        'success',
        false,
        undefined,
        2,
      ),
    ])?.items,
  ).toEqual([
    { outcome: 'done', label: 'Web Search' },
    { outcome: 'done', label: 'Github MCP Create Issue' },
  ]);
  expect(
    structuredJobResultFromRecordedActions([
      terminal(
        'generic-capability-name',
        'billing.sync',
        'success',
        true,
        'Generic detail.',
        1,
      ),
      terminal(
        'owned-capability',
        'billing.sync',
        'success',
        true,
        'Capability detail.',
        2,
        'capability',
      ),
      terminal(
        'owned-capability-2',
        'billing.sync',
        'success',
        true,
        'Second capability detail.',
        3,
        'capability',
      ),
      terminal(
        'browser-open',
        'browser_open',
        'success',
        true,
        'docs.example.test',
        4,
        'browser',
      ),
      terminal(
        'browser-act',
        'browser_act',
        'success',
        true,
        'app.example.test',
        5,
        'browser',
      ),
      terminal(
        'generic-browser-name',
        'Browser',
        'success',
        false,
        'Generic browser detail.',
        6,
      ),
    ])?.items,
  ).toEqual([
    {
      outcome: 'done',
      label: 'Billing Sync',
      detail: 'Generic detail.',
    },
    {
      outcome: 'done',
      label: 'Capability: Billing Sync ×2',
    },
    {
      outcome: 'done',
      label: 'Browser: Open',
      detail: 'docs.example.test',
    },
    {
      outcome: 'done',
      label: 'Browser: Act',
      detail: 'app.example.test',
    },
    {
      outcome: 'done',
      label: 'Browser',
      detail: 'Generic browser detail.',
    },
  ]);
  expect(structuredJobResultFromRecordedActions([])).toBeUndefined();

  const view = boundJobNotificationView({
    status: 'completed',
    jobName: 'Recorded actions',
    result,
    fallbackText: 'The job completed.',
  });
  expect(view.result?.items).toEqual(result?.items);
  expect(view.fallbackText).toBe('The job completed.');

  const repeated = structuredJobResultFromRecordedActions(
    Array.from({ length: 57 }, (_, index) =>
      terminal(
        `repeat-${index}`,
        'veryLongTechnicalIdentifierThatNeedsTruncation',
        'success',
        false,
        undefined,
        index + 1,
      ),
    ),
  );
  const boundedRepeated = boundJobNotificationView({
    status: 'completed',
    jobName: 'Repeated tool',
    result: repeated,
    fallbackText: 'Completed.',
  });
  expect(boundedRepeated.result?.items[0]?.label).toMatch(/\.\.\. ×57$/);
  expect(boundedRepeated.result?.items[0]?.label.length).toBeLessThanOrEqual(
    50,
  );
});

it('keeps only authoritative gantry-owned tool rows and unmatched wrapper failures', () => {
  const terminal = (
    invocationId: string,
    tool: string,
    outcome: 'success' | 'failure',
    authoritative: boolean,
    seq: number,
    family: 'browser' | 'capability',
    detail?: string,
  ) => ({
    eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
    correlationId: invocationId,
    payload: {
      phase: outcome,
      tool,
      family,
      ok: outcome === 'success',
      authoritative,
      invocationId,
      seq,
      ...(detail ? { detail } : {}),
    },
  });
  const result = structuredJobResultFromRecordedActions([
    terminal('browser-1', 'browser_act', 'success', true, 1, 'browser'),
    terminal('browser-2', 'browser_act', 'success', true, 2, 'browser'),
    terminal('browser-3', 'browser_inspect', 'success', true, 3, 'browser'),
    terminal(
      'browser-4',
      'browser_act',
      'failure',
      true,
      4,
      'browser',
      'condorsoftware.com',
    ),
    terminal(
      'browser-5',
      'browser_act',
      'failure',
      true,
      5,
      'browser',
      'condorsoftware.com',
    ),
    terminal('toolu-1', 'Browser', 'success', false, 41, 'browser'),
    terminal('toolu-2', 'Browser', 'success', false, 42, 'browser'),
    terminal('toolu-3', 'Browser', 'success', false, 43, 'browser'),
    terminal('toolu-4', 'Browser', 'failure', false, 44, 'browser'),
    terminal('toolu-5', 'Browser', 'failure', false, 45, 'browser'),
    terminal('toolu-6', 'Browser', 'failure', false, 46, 'browser'),
    terminal(
      'capability-run-1',
      'google.sheets.values.append',
      'success',
      true,
      6,
      'capability',
    ),
    terminal('toolu-7', 'capability_run', 'success', false, 47, 'capability'),
  ]);

  expect(result?.items).toEqual([
    { outcome: 'failed', label: 'Browser: Act ×2' },
    {
      outcome: 'failed',
      label: 'Browser: failed before reaching the browser service',
    },
    { outcome: 'done', label: 'Browser: Act ×2' },
    { outcome: 'done', label: 'Browser: Inspect' },
    { outcome: 'done', label: 'Capability: Google Sheets Values Append' },
  ]);
  expect(result?.items.some((item) => item.label === 'Browser: Browser')).toBe(
    false,
  );
});

it('keeps wrapper-only failures when a shared invocation is deduplicated', () => {
  const terminal = (
    invocationId: string,
    tool: string,
    authoritative: boolean,
    seq: number,
  ) => ({
    eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
    correlationId: invocationId,
    payload: {
      phase: 'failure',
      tool,
      family: 'browser',
      ok: false,
      authoritative,
      invocationId,
      seq,
    },
  });

  expect(
    structuredJobResultFromRecordedActions([
      terminal('shared-1', 'browser_act', true, 10),
      terminal('shared-1', 'Browser', false, 10),
      terminal('toolu-9', 'Browser', false, 11),
    ])?.items,
  ).toEqual([
    { outcome: 'failed', label: 'Browser: Act' },
    {
      outcome: 'failed',
      label: 'Browser: failed before reaching the browser service',
    },
  ]);
});

describe('job status formatting', () => {
  it('bounds structured notification views before provider rendering', () => {
    const longText = (prefix: string) =>
      `${prefix} ${'descriptive words '.repeat(100)}`;
    const view = boundJobNotificationView({
      status: 'completed',
      jobName: longText('Job'),
      stats: {
        toolCount: 12,
        browserUsed: true,
        lastAction: longText('Action'),
      },
      result: {
        headline: longText('Headline'),
        items: Array.from({ length: 12 }, (_, index) => ({
          outcome: 'done' as const,
          label: longText(`Label ${index}`),
          detail: longText(`Detail ${index}`),
        })),
        nextAction: longText('Next action'),
      },
      fallbackText: longText('Fallback'),
      nextRunAt: longText('Next run'),
    });
    const text = [
      view.jobName,
      view.stats?.lastAction,
      view.result?.headline,
      ...(view.result?.items.flatMap((item) => [item.label, item.detail]) ??
        []),
      view.result?.nextAction,
      view.fallbackText,
      view.nextRunAt,
    ]
      .filter((value): value is string => Boolean(value))
      .join('');

    expect(view.result?.items).toHaveLength(10);
    expect(view.result?.headline).toMatch(/\.\.\.$/);
    expect(view.result?.headline.length).toBeLessThanOrEqual(160);
    expect(
      view.result?.items.every(
        (item) => item.label.length <= 50 && item.label.endsWith('...'),
      ),
    ).toBe(true);
    expect(
      view.result?.items.every(
        (item) =>
          item.detail &&
          item.detail.length <= 70 &&
          item.detail.endsWith('...'),
      ),
    ).toBe(true);
    expect(view.result?.nextAction).toMatch(/\.\.\.$/);
    expect(view.result?.nextAction.length).toBeLessThanOrEqual(160);
    expect(view.fallbackText).toMatch(/\.\.\.$/);
    expect(view.fallbackText.length).toBeLessThanOrEqual(500);
    expect(text.length).toBeLessThanOrEqual(
      JOB_NOTIFICATION_VIEW_MAX_TEXT_LENGTH,
    );
  });

  it('truncates multibyte fields without splitting a surrogate pair', () => {
    const view = boundJobNotificationView({
      status: 'completed',
      jobName: '😀'.repeat(200),
      fallbackText: '😀'.repeat(400),
    });
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(view.jobName.endsWith('...')).toBe(true);
    expect(loneSurrogate.test(view.jobName)).toBe(false);
    expect(loneSurrogate.test(view.fallbackText)).toBe(false);
    expect(view.jobName).not.toContain('�');
  });

  it('drops an empty structured result so the fallback is used', () => {
    const view = boundJobNotificationView({
      status: 'completed',
      jobName: 'Test job',
      result: { items: [] },
      fallbackText: 'the narration fallback',
    });
    expect(view.result).toBeUndefined();
    expect(view.fallbackText).toBe('the narration fallback');
  });

  it('keeps a next-action-only structured result', () => {
    const view = boundJobNotificationView({
      status: 'completed',
      jobName: 'Test job',
      result: { items: [], nextAction: 'Approve the pending record' },
      fallbackText: 'fallback',
    });
    expect(view.result).toBeDefined();
    expect(view.result?.nextAction).toBe('Approve the pending record');
  });

  it('adds an explicit action when memory dreaming creates pending reviews', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runShortId: 3,
      runStatus: 'completed',
      summary: 'Memory dreaming needs attention: 4 sent to review.',
      nextRun: '2026-05-20T21:45:00.000Z',
      retryCount: 0,
      durationMs: 311_000,
    });

    expect(message).toContain('**📝 Needs memory review**');
    expect(message).toContain('· Memory Dreaming');
    expect(message).toContain(
      'Memory dreaming needs attention: 4 sent to review.',
    );
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Changed:');
    expect(message).not.toContain('Delegated:');
    expect(message).toContain('4 memory changes need your review.');
    expect(message).not.toContain('Needs attention:');
    expect(message).not.toContain('memory_review_pending');
  });

  it('keeps pending memory review action visible on timeout summaries', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runShortId: 3,
      runStatus: 'timeout',
      summary:
        'memory dreaming deadline exceeded. 2 pending memory reviews need review.',
      nextRun: null,
      retryCount: 1,
      durationMs: 311_000,
    });

    expect(message).toContain('**⏱️ Timed out**');
    expect(message).toContain('· Memory Dreaming');
    expect(message).toContain("I couldn't finish before the job's time limit.");
    expect(message).not.toContain('memory dreaming deadline exceeded');
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Changed:');
    expect(message).not.toContain('Delegated:');
    expect(message).toContain('2 memory changes need your review.');
    expect(message).not.toContain('Rerun with a longer job timeout');
    expect(message).not.toContain('memory_review_pending');
  });

  it('omits empty receipt fields and Next without a concrete next run', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runShortId: 3,
      runStatus: 'completed',
      summary: 'Completed',
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain(
      'I finished the job, but it had no reportable output.',
    );
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Changed:');
    expect(message).not.toContain('Delegated:');
    expect(message).not.toContain('Needs attention:');
    expect(message).not.toContain('Next:');
  });

  it('presents completed reports with real attention as completed with issues', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary:
        '## Final Job Report\nCompleted: Imported 3 records.\nNeeds attention: Approve the remaining record.',
      nextRun: '2026-05-20T21:45:00.000Z',
      retryCount: 0,
    });

    expect(message).toContain('**⚠️ Completed with issues**');
    expect(message).toContain('Approve the remaining record.');
    expect(message.match(/Approve the remaining record\./g)).toHaveLength(1);
    expect(message).toContain('Runs again at ');
    expect(message).not.toContain('Needs attention:');
    expect(message).not.toContain('Next:');
  });

  it('presents degraded completion as completed with limits', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: 'Imported 3 records.',
      nextRun: null,
      retryCount: 0,
      degradedReason:
        'Exact command access was approved for this run only; future runs need permanent approval.',
    });

    expect(message).toContain('**⚠️ Completed with limits**');
    expect(message).toContain(
      '⚠️ Degraded: Exact command access was approved for this run only; future runs need permanent approval.',
    );
  });

  it('keeps the blocker line when the compacted summary truncates it away', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: [
        '## Final Job Report',
        `Completed: ${'Long narrative detail. '.repeat(30)}`,
        'Needs attention: LinkedIn session expired, re-authenticate.',
      ].join('\n'),
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain('**⚠️ Completed with issues**');
    expect(message).toContain('LinkedIn session expired, re-authenticate.');
    expect(message).not.toContain('Needs attention:');
  });

  it('adds terminal run stats and truncates completed reports at a boundary', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: `First sentence is complete. Second sentence carries a meaningful result. ${'Long narration continues without another sentence ending '.repeat(12)}`,
      nextRun: null,
      retryCount: 0,
      durationMs: 34_000,
      diagnostics: {
        pendingPermissionRequests: 0,
        pendingPermissionToolNames: [],
        totalToolCalls: 34,
        browserActivityCount: 1,
        transientPermissionApprovals: [],
        startupDiagnostics: [],
        latestStreamedOutputChars: 0,
        totalStreamedOutputChars: 0,
        terminalToolDenials: [],
        lastTool: 'capability_run',
      },
    });

    expect(message).toContain(
      '34s, 34 tools, browser used, last capability_run',
    );
    expect(message).toContain('Second sentence carries a meaningful result...');
    expect(message).not.toContain('narratio...');
  });

  it('includes structured result items between terminal stats and the summary', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: 'Imported 3 records.',
      nextRun: '2026-05-20T21:45:00.000Z',
      retryCount: 0,
      durationMs: 34_000,
      diagnostics: {
        pendingPermissionRequests: 0,
        pendingPermissionToolNames: [],
        totalToolCalls: 2,
        browserActivityCount: 1,
        transientPermissionApprovals: [],
        startupDiagnostics: [],
        latestStreamedOutputChars: 0,
        totalStreamedOutputChars: 0,
        terminalToolDenials: [],
        lastTool: 'browser_act',
      },
      resultItems: [
        { outcome: 'done', label: 'Web Search ×41' },
        {
          outcome: 'failed',
          label: 'Browser: Act',
          detail: 'startup.jobs',
        },
      ],
    });

    expect(message.split('\n')).toEqual([
      `**✅ Completed** · ${job().name} · 34s`,
      '34s, 2 tools, browser used, last browser_act',
      '✅ Web Search ×41',
      '❌ Browser: Act — startup.jobs',
      'Imported 3 records.',
      expect.stringMatching(/^Runs again at /),
    ]);
  });

  it('keeps terminal summaries byte-identical without structured result items', () => {
    const args = {
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed' as const,
      summary: 'Imported 3 records.',
      nextRun: null,
      retryCount: 0,
      durationMs: 34_000,
      diagnostics: {
        pendingPermissionRequests: 0,
        pendingPermissionToolNames: [],
        totalToolCalls: 2,
        browserActivityCount: 1,
        transientPermissionApprovals: [],
        startupDiagnostics: [],
        latestStreamedOutputChars: 0,
        totalStreamedOutputChars: 0,
        terminalToolDenials: [],
        lastTool: 'browser_act',
      },
    };
    const expected = [
      `**✅ Completed** · ${job().name} · 34s`,
      '34s, 2 tools, browser used, last browser_act',
      'Imported 3 records.',
    ].join('\n');

    expect(formatRunStatusMessage(args)).toBe(expected);
    expect(formatRunStatusMessage({ ...args, resultItems: [] })).toBe(expected);
  });

  it('hard-cuts a boundary-less summary at the limit, not after one character', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: 'a'.repeat(500),
      nextRun: null,
      retryCount: 0,
    });

    // A single long token (URL/hash) has no boundary before the limit, so it
    // hard-cuts near the limit rather than collapsing to "a...".
    expect(message).toContain(`${'a'.repeat(150)}`);
    expect(message).toContain('...');
    expect(message).not.toMatch(/(?:^|\s)a\.\.\./);
  });

  it('does not treat punctuation inside a token as a sentence boundary', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: `Version 2.0 was deployed successfully to the cluster ${'and traffic shifted over '.repeat(20)}`,
      nextRun: null,
      retryCount: 0,
    });

    expect(message).not.toContain('Version 2...');
    expect(message).toContain('Version 2.0 was deployed successfully');
  });

  it('truncates a newline-separated summary at a word boundary', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: `firsttoken\n${'x'.repeat(500)}`,
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain('firsttoken...');
  });

  it('strips trailing agent-authored all-none receipt lines', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'completed',
      summary: `${[
        '## Final Job Report',
        'Completed: Imported 3 records.',
        'Used: none reported',
        'Changed: none',
        'Delegated: no',
        'Needs attention: n/a',
      ].join('\n')}\n`,
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain('Imported 3 records.');
    expect(message).not.toContain('Completed:');
    expect(message).not.toContain('Used:');
    expect(message).not.toContain('Changed: none');
    expect(message).not.toContain('Delegated: no');
    expect(message).not.toContain('Needs attention:');
  });

  it('renders a typed terminal tool denial without developer trailer labels', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runStatus: 'failed',
      summary: 'Permission denied for RunCommand.',
      toolDenial: {
        invocationId: 'denial-run-command',
        toolName: 'RunCommand',
        reason: 'Command access is missing.',
        denialKind: 'permission_denied',
        provenanceLane: DEFAULT_AGENT_ENGINE,
        provenanceSeam: 'gate',
        action: {
          kind: 'approve_grant',
          grant: {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'RunCommand', ruleContent: 'npm test *' }],
          },
        },
      },
      nextRun: null,
      retryCount: 1,
    });

    expect(message).toContain('Missing Run Command access for this job.');
    expect(message).toContain('Approve the missing access');
    expect(message).toContain('Stopped until the job is fixed or rerun.');
    expect(message).not.toMatch(
      /^(?:Completed|Used|Changed|Delegated|Needs attention|Next):/m,
    );
    expect(message).not.toContain('request_access');
  });

  it('selects the scoring summary as the reported completed summary', () => {
    const message = formatRunStatusMessage({
      job: job(),
      runId: 'cb7f3c0a-c8f8-40eb-82f0-3b21d2cfc342',
      runShortId: 3,
      runStatus: 'completed',
      summary: [
        'Intermediate progress notes that should not be reported.',
        '',
        '## Scoring Summary',
        'Scored 5 candidates: 2 shortlist, 1 hold, 2 reject.',
      ].join('\n'),
      nextRun: null,
      retryCount: 0,
    });

    expect(message).toContain(
      'Scoring Summary Scored 5 candidates: 2 shortlist, 1 hold, 2 reject.',
    );
    expect(message).not.toContain('Intermediate progress notes');
  });
});

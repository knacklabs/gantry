import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionContinuityInjectionStatusForTests,
  getLastSessionContinuityInjectionStatus,
  recordSessionContinuityInjectionStatus,
} from '@core/application/sessions/session-continuity-injection-status.js';
import {
  buildAppMemoryContinuityStatus,
  buildAppMemoryContinuitySummary,
} from '@core/memory/app-memory-continuity.js';

describe('app memory continuity summary', () => {
  beforeEach(() => {
    clearSessionContinuityInjectionStatusForTests();
  });

  it('does not return another subject injection status or jobs', async () => {
    recordSessionContinuityInjectionStatus({
      injectedAt: new Date().toISOString(),
      subject: {
        appId: 'default',
        agentId: 'agent:team',
        conversationId: 'conversation:sl:C-other',
        threadId: 'thread:sl:C-other:1',
      },
      bytes: 512,
      maxBytes: 12_000,
      truncated: false,
      blockEmpty: false,
      sections: {
        recent_session_digests: { status: 'empty', count: 0, items: [] },
        top_scoped_memories: { status: 'empty', count: 0, items: [] },
        recent_decisions: { status: 'empty', count: 0, items: [] },
        active_paused_jobs: {
          status: 'populated',
          count: 1,
          items: [{ id: 'job:other', status: 'paused' }],
        },
      },
    });
    const memory = {
      dreamingStatus: async () => [],
      listPendingReviews: async () => [],
      list: async () => [
        {
          id: 'mem:decision',
          appId: 'default',
          agentId: 'agent:team',
          subjectType: 'channel',
          subjectId: 'conversation:sl:C-target',
          channelId: 'conversation:sl:C-target',
          kind: 'decision',
          key: 'decision:target',
          value: 'Keep target continuity isolated.',
          confidence: 0.8,
          isPinned: false,
          version: 1,
          source: 'test',
          evidenceIds: [],
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
      ],
    };

    const summary = await buildAppMemoryContinuitySummary(memory, {
      appId: 'default',
      agentId: 'agent:team',
      channelId: 'conversation:sl:C-target',
      threadId: 'thread:sl:C-target:1',
    });

    expect(summary.last_injected_block).toBeUndefined();
    expect(summary.sections.active_paused_jobs).toMatchObject({
      status: 'unavailable',
      count: 0,
      items: [],
    });
    expect(summary.sections.recent_decisions).toMatchObject({
      status: 'populated',
      count: 1,
      items: [expect.objectContaining({ key: 'decision:target' })],
    });

    const status = await buildAppMemoryContinuityStatus(memory, {
      appId: 'default',
      agentId: 'agent:team',
      channelId: 'conversation:sl:C-target',
      threadId: 'thread:sl:C-target:1',
    });
    expect(status.lastInjectedBlock).toBeUndefined();
    expect(
      getLastSessionContinuityInjectionStatus(undefined as never),
    ).toBeUndefined();
  });

  it('loads dreaming status once when building the continuity summary', async () => {
    const injectedAt = new Date().toISOString();
    recordSessionContinuityInjectionStatus({
      injectedAt,
      subject: {
        appId: 'default',
        agentId: 'agent:team',
        conversationId: 'conversation:sl:C-target',
        threadId: 'thread:sl:C-target:1',
      },
      bytes: 768,
      maxBytes: 12_000,
      truncated: false,
      blockEmpty: false,
      sections: {
        recent_session_digests: {
          status: 'populated',
          count: 1,
          items: [{ id: 'digest:1', preview: 'Recent scoped run' }],
        },
        top_scoped_memories: { status: 'empty', count: 0, items: [] },
        recent_decisions: { status: 'empty', count: 0, items: [] },
        active_paused_jobs: {
          status: 'populated',
          count: 1,
          items: [{ id: 'job:target', status: 'paused' }],
        },
      },
    });

    const dreamRun = {
      completedAt: '2026-05-08T02:00:00.000Z',
      startedAt: '2026-05-08T01:55:00.000Z',
      status: 'completed',
      phase: 'deep',
      summary: {
        staged: 2,
        promoted: 3,
        needsReview: 4,
      },
    };
    const dreamingStatus = vi.fn().mockResolvedValue([dreamRun]);
    const memory = {
      dreamingStatus,
      listPendingReviews: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([
        {
          id: 'mem:decision',
          appId: 'default',
          agentId: 'agent:team',
          subjectType: 'channel',
          subjectId: 'conversation:sl:C-target',
          channelId: 'conversation:sl:C-target',
          kind: 'decision',
          key: 'decision:target',
          value: 'Keep target continuity isolated.',
          confidence: 0.8,
          isPinned: false,
          version: 1,
          source: 'test',
          evidenceIds: [],
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
      ]),
    };

    const summary = await buildAppMemoryContinuitySummary(memory, {
      appId: 'default',
      agentId: 'agent:team',
      channelId: 'conversation:sl:C-target',
      threadId: 'thread:sl:C-target:1',
    });

    expect(dreamingStatus).toHaveBeenCalledTimes(1);
    expect(dreamingStatus.mock.calls[0]?.[0]).toEqual({
      appId: 'default',
      agentId: 'agent:team',
      subjectType: 'channel',
      subjectId: 'conversation:sl:C-target',
      channelId: 'conversation:sl:C-target',
    });
    expect(summary).toMatchObject({
      active_count: 1,
      staged_count: 2,
      promoted_count: 3,
      needs_review_count: 4,
      last_injected_block: {
        subject: 'default:agent:team:conversation:sl:C-target',
        bytes: 768,
        at: injectedAt,
      },
      last_dream_run: {
        at: '2026-05-08T02:00:00.000Z',
        status: 'completed',
        phase: 'deep',
        summary: {
          staged: 2,
          promoted: 3,
          needsReview: 4,
        },
      },
      sections: {
        recent_decisions: {
          status: 'populated',
          count: 1,
          items: [expect.objectContaining({ key: 'decision:target' })],
        },
        active_paused_jobs: {
          status: 'populated',
          count: 1,
          items: [{ id: 'job:target', status: 'paused' }],
        },
        last_runs: {
          status: 'populated',
          count: 1,
          items: [{ id: 'digest:1', preview: 'Recent scoped run' }],
        },
        last_dream_summary: {
          status: 'populated',
          count: 1,
          items: [
            {
              at: '2026-05-08T02:00:00.000Z',
              status: 'completed',
              phase: 'deep',
              summary: {
                staged: 2,
                promoted: 3,
                needsReview: 4,
              },
            },
          ],
        },
      },
    });
  });

  it('marks continuity summary partial when one memory section is unavailable', async () => {
    const memory = {
      dreamingStatus: vi.fn().mockResolvedValue([
        {
          completedAt: '2026-05-08T02:00:00.000Z',
          status: 'completed',
          phase: 'deep',
          summary: { staged: 1, promoted: 0, needsReview: 0 },
        },
      ]),
      listPendingReviews: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockRejectedValue(new Error('memory unavailable')),
    };

    const summary = await buildAppMemoryContinuitySummary(memory, {
      appId: 'default',
      agentId: 'agent:team',
      channelId: 'conversation:sl:C-target',
    });

    expect(summary).toMatchObject({
      overall_status: 'partial',
      active_count: 0,
      staged_count: 1,
      sections: {
        recent_decisions: {
          status: 'unavailable',
          count: 0,
          items: [],
          reason: 'service_error',
        },
        last_dream_summary: {
          status: 'populated',
          count: 1,
        },
      },
    });
  });

  it('marks continuity summary unavailable when every section misses the deadline', async () => {
    const nowMs = Date.parse('2026-05-08T02:00:00.000Z');
    const memory = {
      dreamingStatus: vi.fn().mockResolvedValue([]),
      listPendingReviews: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
    };

    const summary = await buildAppMemoryContinuitySummary(memory, {
      appId: 'default',
      agentId: 'agent:team',
      channelId: 'conversation:sl:C-target',
      deadlineAtMs: nowMs + 500,
      nowMs,
    });

    expect(memory.list).not.toHaveBeenCalled();
    expect(memory.dreamingStatus).not.toHaveBeenCalled();
    expect(memory.listPendingReviews).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      overall_status: 'unavailable',
      sections: {
        recent_decisions: {
          status: 'unavailable',
          reason: 'deadline_exceeded',
        },
        last_dream_summary: {
          status: 'unavailable',
          reason: 'deadline_exceeded',
        },
      },
    });
  });
});

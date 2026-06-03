import { describe, expect, it, vi } from 'vitest';

import { collectDurableMemoryFromRepositories } from '@core/memory/boundary-extraction-core.js';

function fakeRepos(overrides: any) {
  return {
    agentSessions: {
      getAgentSession: vi.fn().mockResolvedValue({
        id: 's1',
        appId: 'default',
        agentId: 'agent:boondi_support',
        conversationId: 'conversation:wa:7000000002',
        threadId: null,
        userId: '7000000002',
      }),
    },
    messages: {
      listRecentMessages: vi.fn().mockResolvedValue([]),
      getMessagesSince: vi.fn().mockResolvedValue([]),
      getMessagesBefore: vi.fn().mockResolvedValue([]),
    },
    memory: {
      listPriorMemoryItems: vi.fn().mockResolvedValue([]),
      saveBoundaryEvidence: vi.fn().mockResolvedValue({ id: 'ev1' }),
    },
    sessionDigests: {
      saveAgentSessionDigest: vi.fn().mockResolvedValue(undefined),
    },
    extractionCursor: {
      getCursor: vi.fn().mockResolvedValue(null),
      upsertCursor: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

const msg = (
  id: string,
  at: string,
  dir: 'inbound' | 'outbound',
  text: string,
) => ({
  id,
  conversationId: 'conversation:wa:7000000002',
  direction: dir,
  createdAt: at,
  parts: [{ kind: 'text', text }],
  attachments: [],
  trust: 'untrusted',
  appId: 'default',
});

describe('collectDurableMemoryFromRepositories (read-watermark)', () => {
  it('with a cursor, reads since it and upserts cursor to max(new)', async () => {
    const repos = fakeRepos({});
    repos.extractionCursor.getCursor.mockResolvedValue({
      coveredThroughAt: '2026-06-04T10:00:00.000Z',
      coveredThroughMessageId: 'm2',
    });
    repos.messages.getMessagesSince.mockResolvedValue([
      msg(
        'm3',
        '2026-06-04T10:05:00.000Z',
        'inbound',
        'I am allergic to peanuts',
      ),
    ]);
    const extractFacts = vi.fn().mockResolvedValue([]);
    await collectDurableMemoryFromRepositories({
      agentSessionId: 's1',
      trigger: 'session-end',
      repositories: repos,
      extractFacts,
      defaultScope: 'user',
    });
    expect(repos.messages.getMessagesSince).toHaveBeenCalledWith(
      expect.objectContaining({
        since: '2026-06-04T10:00:00.000Z',
        sinceId: 'm2',
      }),
    );
    expect(repos.extractionCursor.upsertCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        coveredThroughAt: '2026-06-04T10:05:00.000Z',
        coveredThroughMessageId: 'm3',
      }),
    );
  });

  it('no new messages → early-out: no digest, no extract, no cursor advance', async () => {
    const repos = fakeRepos({});
    repos.extractionCursor.getCursor.mockResolvedValue({
      coveredThroughAt: '2026-06-04T10:00:00.000Z',
      coveredThroughMessageId: 'm2',
    });
    repos.messages.getMessagesSince.mockResolvedValue([]);
    const extractFacts = vi.fn();
    const res = await collectDurableMemoryFromRepositories({
      agentSessionId: 's1',
      trigger: 'session-end',
      repositories: repos,
      extractFacts,
      defaultScope: 'user',
    });
    expect(res).toEqual({ saved: 0 });
    expect(extractFacts).not.toHaveBeenCalled();
    expect(repos.sessionDigests.saveAgentSessionDigest).not.toHaveBeenCalled();
    expect(repos.extractionCursor.upsertCursor).not.toHaveBeenCalled();
  });

  it('null cursor (first run) → bootstrap via listRecentMessages', async () => {
    const repos = fakeRepos({});
    repos.messages.listRecentMessages.mockResolvedValue([
      msg(
        'm1',
        '2026-06-04T09:00:00.000Z',
        'inbound',
        'hi, do you do gifting?',
      ),
    ]);
    await collectDurableMemoryFromRepositories({
      agentSessionId: 's1',
      trigger: 'session-end',
      repositories: repos,
      extractFacts: vi.fn().mockResolvedValue([]),
      defaultScope: 'user',
    });
    expect(repos.messages.listRecentMessages).toHaveBeenCalled();
    expect(repos.extractionCursor.upsertCursor).toHaveBeenCalledWith(
      expect.objectContaining({ coveredThroughMessageId: 'm1' }),
    );
  });
});

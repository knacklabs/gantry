import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  routes: new Map<string, { name: string; folder: string }>(),
  deleteSession: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  pruneDesiredStateAgent: vi.fn(async (input: { remainingRoutes: number }) => ({
    pruned: input.remainingRoutes === 0,
  })),
}));

vi.mock('@clack/prompts', () => ({
  isCancel: vi.fn(() => false),
  log: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() },
  select: vi.fn(),
}));

vi.mock('@core/cli/group-helpers.js', () => ({
  allocateGroupFolder: vi.fn(),
  conversationIdsForProvider: vi.fn(),
  disableRemovedAgentProjection: vi.fn(),
  ensureGroupFiles: vi.fn(),
  findConversationIdForAgent: vi.fn(),
  formatAgentHarnessLine: vi.fn(),
  isInteractiveTerminal: vi.fn(() => false),
  loadDatabase: vi.fn(async () => ({
    close: state.close,
    deleteConversationRoute: async (jid: string) => {
      state.routes.delete(jid);
    },
    deleteSession: state.deleteSession,
    getAllConversationRoutes: async () => Object.fromEntries(state.routes),
  })),
  normalizeGroupAddSelector: vi.fn(),
  pruneAgentSenderPolicyOverride: vi.fn(async () => ({ pruned: false })),
  pruneDesiredStateAgent: state.pruneDesiredStateAgent,
  resolveGroupSelector: (
    groups: Record<string, { name: string; folder: string }>,
    selector: string,
  ) => {
    const group = groups[selector];
    return group ? { found: { jid: selector, group } } : { found: null };
  },
  seedTelegramControlApproverForAgent: vi.fn(),
  usage: vi.fn(() => ''),
}));

import { runAgentCommand } from '@core/cli/group.js';

beforeEach(() => {
  state.routes.clear();
  state.deleteSession.mockClear();
  state.close.mockClear();
  state.pruneDesiredStateAgent.mockClear();
});

describe('gantry agent remove', () => {
  it("deletes only the removed route's own session, scoped to its conversation", async () => {
    state.routes.set('tg:removed', { name: 'Removed', folder: 'shared' });
    state.routes.set('tg:kept', { name: 'Kept', folder: 'shared' });

    expect(
      await runAgentCommand('/tmp/gantry-group-remove', [
        'remove',
        'tg:removed',
        '--yes',
      ]),
    ).toBe(0);

    // Scoped to the removed route's conversation, never a folder-wide wipe, so
    // the sibling route sharing the folder is untouched (and there is no stale
    // route count to race a concurrent write).
    expect(state.deleteSession).toHaveBeenCalledTimes(1);
    expect(state.deleteSession).toHaveBeenCalledWith(
      'shared',
      null,
      expect.objectContaining({ conversationJid: 'tg:removed' }),
    );
  });

  it("still clears the route's session when the agent is retained for a delegate", async () => {
    state.routes.set('tg:only', { name: 'Only', folder: 'delegated' });
    state.pruneDesiredStateAgent.mockImplementationOnce(async () => ({
      pruned: false,
      keptForDelegates: ['agent:other'],
    }));

    expect(
      await runAgentCommand('/tmp/gantry-group-remove', [
        'remove',
        'tg:only',
        '--yes',
      ]),
    ).toBe(0);

    expect(state.deleteSession).toHaveBeenCalledWith(
      'delegated',
      null,
      expect.objectContaining({ conversationJid: 'tg:only' }),
    );
  });

  it('does not fail the command when session cleanup rejects', async () => {
    state.routes.set('tg:err', { name: 'Err', folder: 'errfolder' });
    state.deleteSession.mockRejectedValueOnce(new Error('db down'));

    expect(
      await runAgentCommand('/tmp/gantry-group-remove', [
        'remove',
        'tg:err',
        '--yes',
      ]),
    ).toBe(0);
    expect(state.deleteSession).toHaveBeenCalledWith(
      'errfolder',
      null,
      expect.objectContaining({ conversationJid: 'tg:err' }),
    );
  });
});

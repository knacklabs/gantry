import { describe, expect, it } from 'vitest';

import {
  routeLiveCloseStdin,
  routeLiveContinuation,
  routeLiveStop,
} from '@core/runtime/live-turn-routing.js';
import type { LiveTurnScope } from '@core/domain/ports/live-turns.js';
import { makeLiveTurnScopeKey } from '@core/domain/ports/live-turns.js';

import { FakeLiveTurnInbox, makeFakeLiveTurn } from './live-turn-fakes.js';

const SCOPE: LiveTurnScope = {
  appId: 'default',
  agentSessionId: 'session-1',
  conversationId: 'tg:routing',
  threadId: 't-1',
};

function makeInboxWithTurn(patch = {}) {
  const inbox = new FakeLiveTurnInbox();
  const turn = inbox.addTurn(
    makeFakeLiveTurn({
      id: 'turn-routing',
      scopeKey: makeLiveTurnScopeKey(SCOPE),
      conversationId: SCOPE.conversationId,
      threadId: SCOPE.threadId ?? null,
      agentSessionId: SCOPE.agentSessionId ?? null,
      ...patch,
    }),
  );
  return { inbox, turn };
}

describe('routeLiveContinuation', () => {
  it('appends a continuation command to the owning turn', async () => {
    const { inbox } = makeInboxWithTurn();
    const result = await routeLiveContinuation({
      liveTurns: inbox,
      scope: SCOPE,
      text: 'follow-up text',
      commandId: 'cmd-1',
      idempotencyKey: 'continuation:msg-1',
      createdByWorkerId: 'w2',
    });
    expect(result.outcome).toBe('queued_to_owner');
    if (result.outcome !== 'queued_to_owner') return;
    expect(result.command).toMatchObject({
      commandType: 'continuation',
      seq: 1,
      payload: { text: 'follow-up text', threadId: 't-1' },
      createdByWorkerId: 'w2',
    });
  });

  it('reports no active turn so the caller can start a new one', async () => {
    const inbox = new FakeLiveTurnInbox();
    await expect(
      routeLiveContinuation({
        liveTurns: inbox,
        scope: SCOPE,
        text: 'hello',
        commandId: 'cmd-1',
        idempotencyKey: 'continuation:msg-1',
      }),
    ).resolves.toEqual({ outcome: 'no_active_turn' });
  });

  it('treats a terminal race during append as no active turn', async () => {
    const { inbox, turn } = makeInboxWithTurn();
    const liveTurns = {
      getActiveLiveTurn: async () => turn,
      findActiveLiveTurnByStopAlias:
        inbox.findActiveLiveTurnByStopAlias.bind(inbox),
      appendLiveTurnCommand: async () => {
        // The turn settled between resolution and append.
        return { outcome: 'rejected' as const, command: null };
      },
    };
    await expect(
      routeLiveContinuation({
        liveTurns,
        scope: SCOPE,
        text: 'hello',
        commandId: 'cmd-1',
        idempotencyKey: 'continuation:msg-1',
      }),
    ).resolves.toEqual({ outcome: 'no_active_turn' });
  });

  it('enforces the required continuation user durably', async () => {
    const { inbox } = makeInboxWithTurn({
      requiredContinuationUserId: 'user-owner',
    });
    const denied = await routeLiveContinuation({
      liveTurns: inbox,
      scope: SCOPE,
      text: 'not yours',
      senderUserIds: ['user-other'],
      commandId: 'cmd-1',
      idempotencyKey: 'continuation:msg-1',
    });
    expect(denied.outcome).toBe('sender_not_allowed');
    expect(inbox.commands).toHaveLength(0);

    const allowed = await routeLiveContinuation({
      liveTurns: inbox,
      scope: SCOPE,
      text: 'mine',
      senderUserIds: ['user-owner'],
      commandId: 'cmd-2',
      idempotencyKey: 'continuation:msg-2',
    });
    expect(allowed.outcome).toBe('queued_to_owner');
  });

  it('is idempotent on redelivered messages', async () => {
    const { inbox } = makeInboxWithTurn();
    const first = await routeLiveContinuation({
      liveTurns: inbox,
      scope: SCOPE,
      text: 'hello',
      commandId: 'cmd-1',
      idempotencyKey: 'continuation:msg-1',
    });
    const replay = await routeLiveContinuation({
      liveTurns: inbox,
      scope: SCOPE,
      text: 'hello',
      commandId: 'cmd-1-replay',
      idempotencyKey: 'continuation:msg-1',
    });
    expect(replay.outcome).toBe('queued_to_owner');
    if (
      first.outcome !== 'queued_to_owner' ||
      replay.outcome !== 'queued_to_owner'
    ) {
      return;
    }
    expect(replay.command.id).toBe(first.command.id);
    expect(inbox.commands).toHaveLength(1);
  });

  it('does not report an already rejected replayed continuation as queued', async () => {
    const { inbox } = makeInboxWithTurn();
    const first = await routeLiveContinuation({
      liveTurns: inbox,
      scope: SCOPE,
      text: 'hello',
      commandId: 'cmd-1',
      idempotencyKey: 'continuation:msg-1',
    });
    expect(first.outcome).toBe('queued_to_owner');
    inbox.commands[0]!.status = 'rejected';
    inbox.commands[0]!.rejectedReason = 'replayed from cursor during recovery';

    await expect(
      routeLiveContinuation({
        liveTurns: inbox,
        scope: SCOPE,
        text: 'hello',
        commandId: 'cmd-1-replay',
        idempotencyKey: 'continuation:msg-1',
      }),
    ).resolves.toEqual({ outcome: 'no_active_turn' });
  });
});

describe('routeLiveStop', () => {
  it('routes a stop by scope to the owner inbox', async () => {
    const { inbox } = makeInboxWithTurn();
    const result = await routeLiveStop({
      liveTurns: inbox,
      scope: SCOPE,
      commandId: 'cmd-stop',
      idempotencyKey: 'stop:msg-9',
      requestedBy: 'user-1',
    });
    expect(result.outcome).toBe('queued_to_owner');
    if (result.outcome !== 'queued_to_owner') return;
    expect(result.command).toMatchObject({
      commandType: 'stop',
      payload: { requestedBy: 'user-1' },
    });
  });

  it('resolves durable stop aliases when the scope does not match', async () => {
    const { inbox, turn } = makeInboxWithTurn({
      stopAliasJids: ['scheduler:ephemeral-1'],
    });
    const result = await routeLiveStop({
      liveTurns: inbox,
      aliasJid: 'scheduler:ephemeral-1',
      commandId: 'cmd-stop',
      idempotencyKey: 'stop:alias-1',
    });
    expect(result.outcome).toBe('queued_to_owner');
    if (result.outcome !== 'queued_to_owner') return;
    expect(result.turn.id).toBe(turn.id);
  });

  it('reports no active turn for unknown scopes and aliases', async () => {
    const inbox = new FakeLiveTurnInbox();
    await expect(
      routeLiveStop({
        liveTurns: inbox,
        scope: SCOPE,
        aliasJid: 'unknown',
        commandId: 'cmd-stop',
        idempotencyKey: 'stop:none',
      }),
    ).resolves.toEqual({ outcome: 'no_active_turn' });
  });
});

describe('routeLiveCloseStdin', () => {
  it('routes close-stdin to the owner inbox', async () => {
    const { inbox } = makeInboxWithTurn();
    const result = await routeLiveCloseStdin({
      liveTurns: inbox,
      scope: SCOPE,
      commandId: 'cmd-close',
      idempotencyKey: 'close:msg-1',
    });
    expect(result.outcome).toBe('queued_to_owner');
    if (result.outcome !== 'queued_to_owner') return;
    expect(result.command.commandType).toBe('close_stdin');
  });
});

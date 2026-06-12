import { describe, expect, it } from 'vitest';

import { createLiveTurnCommandPump } from '@core/runtime/live-turn-command-pump.js';
import type {
  LiveTurnCommand,
  LiveTurnLeaseFence,
} from '@core/domain/ports/live-turns.js';

import { FakeLiveTurnInbox, makeFakeLiveTurn } from './live-turn-fakes.js';

const FENCE: LiveTurnLeaseFence = {
  leaseToken: 'lease-1',
  workerInstanceId: 'w1',
  fencingVersion: 1,
};

async function makeInboxWithCommands(
  types: Array<'continuation' | 'stop' | 'close_stdin' | 'compact'>,
): Promise<FakeLiveTurnInbox> {
  const inbox = new FakeLiveTurnInbox();
  inbox.addTurn(makeFakeLiveTurn({ id: 'turn-pump' }));
  for (const [index, commandType] of types.entries()) {
    await inbox.appendLiveTurnCommand({
      id: `cmd-${index + 1}`,
      liveTurnId: 'turn-pump',
      commandType,
      idempotencyKey: `${commandType}:${index + 1}`,
      payload: { index: index + 1 },
    });
  }
  return inbox;
}

describe('createLiveTurnCommandPump', () => {
  it('scopes command idempotency replay to the live turn', async () => {
    const inbox = new FakeLiveTurnInbox();
    inbox.addTurn(makeFakeLiveTurn({ id: 'turn-1' }));
    inbox.addTurn(makeFakeLiveTurn({ id: 'turn-2' }));

    const first = await inbox.appendLiveTurnCommand({
      id: 'cmd-1',
      liveTurnId: 'turn-1',
      commandType: 'continuation',
      idempotencyKey: 'continuation:same-message',
    });
    const replay = await inbox.appendLiveTurnCommand({
      id: 'cmd-1-replay',
      liveTurnId: 'turn-1',
      commandType: 'continuation',
      idempotencyKey: 'continuation:same-message',
    });
    const secondTurn = await inbox.appendLiveTurnCommand({
      id: 'cmd-2',
      liveTurnId: 'turn-2',
      commandType: 'continuation',
      idempotencyKey: 'continuation:same-message',
    });

    expect(first.outcome).toBe('appended');
    expect(replay.outcome).toBe('replayed');
    expect(replay.command?.id).toBe('cmd-1');
    expect(secondTurn.outcome).toBe('appended');
    expect(secondTurn.command?.liveTurnId).toBe('turn-2');
  });

  it('applies pending commands in sequence order and marks them consumed', async () => {
    const inbox = await makeInboxWithCommands([
      'continuation',
      'continuation',
      'stop',
    ]);
    const applied: Array<{ type: string; seq: number }> = [];
    const pump = createLiveTurnCommandPump({
      liveTurns: inbox,
      turnId: 'turn-pump',
      fence: FENCE,
      handlers: {
        continuation: (command) => {
          applied.push({ type: 'continuation', seq: command.seq });
          return 'applied';
        },
        stop: (command) => {
          applied.push({ type: 'stop', seq: command.seq });
          return 'applied';
        },
      },
    });
    await expect(pump.drain()).resolves.toBe(3);
    expect(applied).toEqual([
      { type: 'continuation', seq: 1 },
      { type: 'continuation', seq: 2 },
      { type: 'stop', seq: 3 },
    ]);
    expect(inbox.commands.map((command) => command.status)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    expect(
      inbox.commands.every(
        (command) => command.appliedByWorkerId === FENCE.workerInstanceId,
      ),
    ).toBe(true);
  });

  it('leaves a retrying command pending and stops before later commands', async () => {
    const inbox = await makeInboxWithCommands(['continuation', 'stop']);
    let attempts = 0;
    const errors: unknown[] = [];
    const pump = createLiveTurnCommandPump({
      liveTurns: inbox,
      turnId: 'turn-pump',
      fence: FENCE,
      handlers: {
        continuation: () => {
          attempts += 1;
          return attempts > 1 ? 'applied' : 'retry';
        },
        stop: () => 'applied',
      },
      onError: (err) => errors.push(err),
    });
    await expect(pump.drain()).resolves.toBe(0);
    expect(inbox.commands.map((command) => command.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(errors).toHaveLength(1);
    await expect(pump.drain()).resolves.toBe(2);
    expect(inbox.commands.map((command) => command.status)).toEqual([
      'applied',
      'applied',
    ]);
  });

  it('rejects commands without a handler and keeps draining', async () => {
    const inbox = await makeInboxWithCommands(['compact', 'continuation']);
    const pump = createLiveTurnCommandPump({
      liveTurns: inbox,
      turnId: 'turn-pump',
      fence: FENCE,
      handlers: {
        continuation: () => 'applied',
      },
    });
    await expect(pump.drain()).resolves.toBe(1);
    expect(inbox.commands[0]).toMatchObject({
      status: 'rejected',
      rejectedReason: expect.stringContaining('unsupported'),
    });
    expect(inbox.commands[1]?.status).toBe('applied');
  });

  it('halts when the fence no longer matches the active lease', async () => {
    const inbox = await makeInboxWithCommands(['continuation', 'stop']);
    // A recovered owner now holds the turn at a newer lease.
    inbox.activeLeaseTokenByTurn.set('turn-pump', 'lease-2');
    const seen: LiveTurnCommand[] = [];
    const pump = createLiveTurnCommandPump({
      liveTurns: inbox,
      turnId: 'turn-pump',
      fence: FENCE,
      handlers: {
        continuation: (command) => {
          seen.push(command);
          return 'applied';
        },
        stop: (command) => {
          seen.push(command);
          return 'applied';
        },
      },
    });
    await expect(pump.drain()).resolves.toBe(0);
    // The stale owner consumes nothing and runs no local side effects; both
    // commands remain for the recovered owner.
    expect(seen).toHaveLength(0);
    expect(inbox.commands.map((command) => command.status)).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('does not reject unsupported commands after losing the lease', async () => {
    const inbox = await makeInboxWithCommands(['compact', 'continuation']);
    inbox.activeLeaseTokenByTurn.set('turn-pump', 'lease-2');
    const pump = createLiveTurnCommandPump({
      liveTurns: inbox,
      turnId: 'turn-pump',
      fence: FENCE,
      handlers: {
        continuation: () => 'applied',
      },
    });
    await expect(pump.drain()).resolves.toBe(0);
    expect(inbox.commands.map((command) => command.status)).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('surfaces handler errors without consuming the pending command', async () => {
    const inbox = await makeInboxWithCommands(['continuation']);
    const errors: unknown[] = [];
    const pump = createLiveTurnCommandPump({
      liveTurns: inbox,
      turnId: 'turn-pump',
      fence: FENCE,
      handlers: {
        continuation: () => {
          throw new Error('ipc write failed');
        },
      },
      onError: (err) => errors.push(err),
    });
    await expect(pump.drain()).resolves.toBe(0);
    expect(errors).toHaveLength(1);
    expect(inbox.commands[0]?.status).toBe('pending');
  });

  it('coalesces concurrent drains', async () => {
    const inbox = await makeInboxWithCommands(['continuation']);
    let inFlight = 0;
    let maxInFlight = 0;
    const pump = createLiveTurnCommandPump({
      liveTurns: inbox,
      turnId: 'turn-pump',
      fence: FENCE,
      handlers: {
        continuation: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return 'applied';
        },
      },
    });
    await Promise.all([pump.drain(), pump.drain(), pump.drain()]);
    expect(maxInFlight).toBe(1);
    expect(inbox.commands[0]?.status).toBe('applied');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { LiveTurnAuthority } from '@core/runtime/live-turn-authority.js';
import {
  createIpcAuthEnvelope,
  getIpcResponseSigningPrivateKey,
  revokeIpcResponseSigningKey,
  sealIpcResponseSigningPrivateKey,
} from '@core/runtime/ipc-auth.js';
import {
  liveTurnSlotKey,
  liveTurnSlotHolderId,
} from '@core/application/live-turns/live-turn-lease-service.js';
import type {
  LiveTurnCommandWakeupSource,
  LiveTurnCoordinationRepository,
  LiveTurnScope,
} from '@core/domain/ports/live-turns.js';

import {
  FakeCoordination,
  FakeLiveTurns,
} from '../application/live-turn-lease-fakes.js';

const QUEUE_JID = 'group1@g.us';

function makeScope(patch: Partial<LiveTurnScope> = {}): LiveTurnScope {
  return {
    appId: 'default',
    agentSessionId: 'session-1',
    conversationId: QUEUE_JID,
    threadId: null,
    ...patch,
  };
}

function makeCommandWakeupSource(): {
  source: LiveTurnCommandWakeupSource;
  wake: () => void;
} {
  const listeners = new Set<() => void>();
  return {
    source: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: async () => undefined,
    },
    wake: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

function makeAuthority(
  workerInstanceId = 'w1',
  commandWakeupSource?: LiveTurnCommandWakeupSource,
) {
  const liveTurns = new FakeLiveTurns();
  const coordination = new FakeCoordination();
  liveTurns.coordination = coordination;
  const warnings: string[] = [];
  const authority = new LiveTurnAuthority({
    leaseDeps: {
      liveTurns: liveTurns as unknown as LiveTurnCoordinationRepository,
      coordination,
      workerInstanceId,
    },
    slotCapacity: () => 3,
    leaseTtlMs: 60_000,
    commandWakeupSource,
    warn: (_context, message) => warnings.push(message),
  });
  return { authority, liveTurns, coordination, warnings };
}

interface HookLog {
  continuations: Array<{ text: string; sequence: number }>;
  stops: number;
  closes: number;
  uiRestarts: number;
}

function makeHooks(): {
  hooks: Parameters<LiveTurnAuthority['registerLocalRunner']>[1];
  log: HookLog;
} {
  const log: HookLog = {
    continuations: [],
    stops: 0,
    closes: 0,
    uiRestarts: 0,
  };
  return {
    log,
    hooks: {
      applyContinuation: ({ text, sequence }) => {
        log.continuations.push({ text, sequence });
      },
      applyCloseStdin: () => {
        log.closes += 1;
      },
      applyStop: () => {
        log.stops += 1;
      },
      onContinuationApplied: () => {
        log.uiRestarts += 1;
      },
    },
  };
}

describe('LiveTurnAuthority', () => {
  it('admits a turn, runs it, applies routed continuations locally, and finalizes', async () => {
    const { authority, liveTurns } = makeAuthority();
    const admission = await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    expect(admission.outcome).toBe('claimed');
    expect(authority.ownsQueue(QUEUE_JID)).toBe(true);

    const { hooks, log } = makeHooks();
    await authority.registerLocalRunner(QUEUE_JID, hooks);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('running');

    // A continuation routed from any worker reaches the local runner with
    // the durable sequence.
    const routed = await authority.routeMessage({
      scope: makeScope(),
      queueJid: QUEUE_JID,
      text: 'follow-up',
      idempotencyKey: 'continuation:msg-1',
    });
    expect(routed).toBe('queued_to_owner');
    await authority.drainQueue(QUEUE_JID);
    expect(log.continuations).toEqual([{ text: 'follow-up', sequence: 1 }]);
    expect(log.uiRestarts).toBe(1);

    await expect(authority.finalize(QUEUE_JID, 'completed')).resolves.toBe(
      true,
    );
    expect(authority.ownsQueue(QUEUE_JID)).toBe(false);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('completed');
    await authority.shutdown();
  });

  it('refuses new admissions once draining but lets active turns keep their lease', async () => {
    const { authority } = makeAuthority();
    const first = await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    expect(first.outcome).toBe('claimed');

    authority.beginDraining();

    const second = await authority.admit({
      queueJid: 'group2@g.us',
      scope: makeScope({ conversationId: 'group2@g.us' }),
      turnId: 'turn-2',
      runId: 'run-2',
    });
    // New admission is refused so a successor live host recovers the turn.
    expect(second.outcome).toBe('lease_unavailable');
    // The already-active turn is untouched and keeps running to completion.
    expect(authority.ownsQueue(QUEUE_JID)).toBe(true);
    await authority.shutdown();
  });

  it('releases active fenced leases and slots during shutdown', async () => {
    const { authority, liveTurns, coordination } = makeAuthority();
    const admission = await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    expect(admission.outcome).toBe('claimed');
    if (admission.outcome !== 'claimed') return;
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([
      liveTurnSlotHolderId('turn-1', admission.fence.fencingVersion),
    ]);

    await authority.shutdown();

    expect(authority.ownsQueue(QUEUE_JID)).toBe(false);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('failed');
    expect(coordination.leases).toMatchObject([
      {
        runId: 'run-1',
        status: 'released',
      },
    ]);
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
  });

  it('releases the owner without finalizing when routed continuations are still pending', async () => {
    const { authority, liveTurns, coordination } = makeAuthority();
    const admission = await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    if (admission.outcome !== 'claimed') throw new Error('admission failed');
    await authority.routeMessage({
      scope: makeScope(),
      queueJid: QUEUE_JID,
      text: 'pending follow-up',
      idempotencyKey: 'continuation:pending',
    });

    await expect(authority.finalize(QUEUE_JID, 'completed')).resolves.toBe(
      false,
    );
    expect(authority.ownsQueue(QUEUE_JID)).toBe(false);
    expect(liveTurns.turns.get('turn-1')?.state).toBe('claimed');
    expect(liveTurns.commands[0]?.status).toBe('pending');
    expect(coordination.leases).toContainEqual(
      expect.objectContaining({
        runId: 'run-1',
        status: 'released',
      }),
    );
    expect(coordination.slotHolders(liveTurnSlotKey('w1'))).toEqual([]);
    await authority.shutdown();
  });

  it('drains pending interaction resolutions before finalizing a completed turn', async () => {
    const { authority, liveTurns, coordination } = makeAuthority();
    const admission = await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    if (admission.outcome !== 'claimed') throw new Error('admission failed');
    const { hooks } = makeHooks();
    await authority.registerLocalRunner(QUEUE_JID, {
      ...hooks,
      onInteractionResolved: () => true,
    });
    await liveTurns.appendLiveTurnCommand({
      id: 'cmd-interaction-resolved',
      liveTurnId: 'turn-1',
      commandType: 'interaction_resolved',
      idempotencyKey: 'interaction_resolved:permission:agent-folder:req-1',
      payload: {
        kind: 'permission',
        requestId: 'req-1',
        sourceAgentFolder: 'agent-folder',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        callbackRoute: {},
      },
    });

    await expect(authority.finalize(QUEUE_JID, 'completed')).resolves.toBe(
      true,
    );

    expect(liveTurns.commands[0]?.status).toBe('applied');
    expect(liveTurns.turns.get('turn-1')?.state).toBe('completed');
    expect(coordination.leases).toContainEqual(
      expect.objectContaining({
        runId: 'run-1',
        status: 'completed',
      }),
    );
  });

  it('routes stop and close-stdin commands to the local runner hooks', async () => {
    const { authority } = makeAuthority();
    await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
      stopAliasJids: ['alias-1'],
    });
    const { hooks, log } = makeHooks();
    await authority.registerLocalRunner(QUEUE_JID, hooks);

    await expect(
      authority.routeStop({
        aliasJid: 'alias-1',
        queueJid: QUEUE_JID,
        idempotencyKey: 'stop:msg-1',
        requestedBy: 'user-1',
      }),
    ).resolves.toBe(true);
    await expect(
      authority.routeCloseStdin({
        scope: makeScope(),
        queueJid: QUEUE_JID,
        idempotencyKey: 'close:msg-2',
      }),
    ).resolves.toBe(true);
    await authority.drainQueue(QUEUE_JID);
    expect(log.stops).toBe(1);
    expect(log.closes).toBe(1);
    await authority.finalize(QUEUE_JID, 'failed');
    await authority.shutdown();
  });

  it('persists runner routing metadata before accepting remote continuations', async () => {
    const { authority, liveTurns } = makeAuthority();
    await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    const { hooks } = makeHooks();
    await authority.registerLocalRunner(QUEUE_JID, hooks, {
      stopAliasJids: ['alias-1'],
      requiredContinuationUserId: 'user-1',
    });

    expect(liveTurns.turns.get('turn-1')).toMatchObject({
      stopAliasJids: ['alias-1'],
      requiredContinuationUserId: 'user-1',
    });
    await expect(
      authority.routeMessage({
        scope: makeScope(),
        queueJid: QUEUE_JID,
        text: 'wrong sender',
        idempotencyKey: 'continuation:wrong',
        senderUserIds: ['user-2'],
      }),
    ).resolves.toBe('sender_not_allowed');
    await expect(
      authority.routeMessage({
        scope: makeScope(),
        queueJid: QUEUE_JID,
        text: 'right sender',
        idempotencyKey: 'continuation:right',
        senderUserIds: ['user-1'],
      }),
    ).resolves.toBe('queued_to_owner');
    await authority.finalize(QUEUE_JID, 'completed');
    await authority.shutdown();
  });

  it('registers Stop aliases without clearing continuation sender restrictions', async () => {
    const { authority, liveTurns } = makeAuthority();
    await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
      requiredContinuationUserId: 'user-1',
    });
    const { hooks } = makeHooks();
    await authority.registerLocalRunner(QUEUE_JID, hooks, {
      requiredContinuationUserId: 'user-1',
    });

    await expect(
      authority.registerStopAliases(QUEUE_JID, ['stop-token-1']),
    ).resolves.toBe(true);

    expect(liveTurns.turns.get('turn-1')).toMatchObject({
      stopAliasJids: ['stop-token-1'],
      requiredContinuationUserId: 'user-1',
    });
    await expect(
      authority.routeMessage({
        scope: makeScope(),
        queueJid: QUEUE_JID,
        text: 'wrong sender',
        idempotencyKey: 'continuation:wrong-after-stop-alias',
        senderUserIds: ['user-2'],
      }),
    ).resolves.toBe('sender_not_allowed');
    await authority.finalize(QUEUE_JID, 'completed');
    await authority.shutdown();
  });

  it('keeps commands pending until the runner hooks are registered', async () => {
    const { authority, liveTurns } = makeAuthority();
    await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    await authority.routeMessage({
      scope: makeScope(),
      queueJid: QUEUE_JID,
      text: 'early follow-up',
      idempotencyKey: 'continuation:early',
    });
    await authority.drainQueue(QUEUE_JID);
    // No hooks yet: the command stays pending (retry), nothing is lost.
    expect(liveTurns.commands[0]?.status).toBe('pending');

    const { hooks, log } = makeHooks();
    await authority.registerLocalRunner(QUEUE_JID, hooks);
    await authority.drainQueue(QUEUE_JID);
    expect(log.continuations).toEqual([
      { text: 'early follow-up', sequence: 1 },
    ]);
    expect(liveTurns.commands[0]?.status).toBe('applied');
    await authority.finalize(QUEUE_JID, 'completed');
    await authority.shutdown();
  });

  it('drains remote commands on command wakeup before the owner tick', async () => {
    const wakeup = makeCommandWakeupSource();
    const { authority, liveTurns } = makeAuthority('w1', wakeup.source);
    await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    const { hooks, log } = makeHooks();
    await authority.registerLocalRunner(QUEUE_JID, hooks);

    await liveTurns.appendLiveTurnCommand({
      id: 'remote-cmd-1',
      liveTurnId: 'turn-1',
      commandType: 'continuation',
      idempotencyKey: 'continuation:remote',
      payload: { text: 'remote follow-up', threadId: null },
      createdByWorkerId: 'w2',
    });
    expect(log.continuations).toEqual([]);

    wakeup.wake();

    await vi.waitFor(
      () =>
        expect(log.continuations).toEqual([
          { text: 'remote follow-up', sequence: 1 },
        ]),
      { timeout: 250 },
    );
    expect(liveTurns.commands[0]?.status).toBe('applied');
    await authority.finalize(QUEUE_JID, 'completed');
    await authority.shutdown();
  });

  it('checks ownership before applying wakeup commands', async () => {
    const wakeup = makeCommandWakeupSource();
    const { authority, liveTurns, coordination, warnings } = makeAuthority(
      'w1',
      wakeup.source,
    );
    const admission = await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    expect(admission.outcome).toBe('claimed');
    if (admission.outcome !== 'claimed') return;
    const { hooks, log } = makeHooks();
    await authority.registerLocalRunner(QUEUE_JID, hooks);
    await liveTurns.appendLiveTurnCommand({
      id: 'remote-cmd-1',
      liveTurnId: 'turn-1',
      commandType: 'continuation',
      idempotencyKey: 'continuation:remote',
      payload: { text: 'remote follow-up', threadId: null },
      createdByWorkerId: 'w2',
    });
    coordination.slots
      .get(liveTurnSlotKey('w1'))
      ?.delete(liveTurnSlotHolderId('turn-1', admission.fence.fencingVersion));

    wakeup.wake();

    await vi.waitFor(() => expect(log.stops).toBe(1), { timeout: 250 });
    expect(log.continuations).toEqual([]);
    expect(liveTurns.commands[0]?.status).toBe('pending');
    expect(authority.ownsQueue(QUEUE_JID)).toBe(false);
    expect(warnings).toContain(
      'Live turn ownership lost; stopping local runner',
    );
    await authority.shutdown();
  });

  it('leaves remote commands pending when the wakeup is missed', async () => {
    vi.useFakeTimers();
    try {
      const { authority, liveTurns } = makeAuthority('w1');
      await authority.admit({
        queueJid: QUEUE_JID,
        scope: makeScope(),
        turnId: 'turn-1',
        runId: 'run-1',
      });
      const { hooks, log } = makeHooks();
      await authority.registerLocalRunner(QUEUE_JID, hooks);
      await liveTurns.appendLiveTurnCommand({
        id: 'remote-cmd-1',
        liveTurnId: 'turn-1',
        commandType: 'continuation',
        idempotencyKey: 'continuation:remote',
        payload: { text: 'remote follow-up', threadId: null },
        createdByWorkerId: 'w2',
      });

      await Promise.resolve();
      expect(log.continuations).toEqual([]);
      expect(liveTurns.commands[0]?.status).toBe('pending');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(log.continuations).toEqual([
        { text: 'remote follow-up', sequence: 1 },
      ]);
      expect(liveTurns.commands[0]?.status).toBe('applied');
      await authority.finalize(QUEUE_JID, 'completed');
      await authority.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the local runner when the live-turn slot is lost', async () => {
    vi.useFakeTimers();
    try {
      const { authority, coordination, warnings } = makeAuthority();
      const admission = await authority.admit({
        queueJid: QUEUE_JID,
        scope: makeScope(),
        turnId: 'turn-1',
        runId: 'run-1',
      });
      expect(admission.outcome).toBe('claimed');
      if (admission.outcome !== 'claimed') return;
      const { hooks, log } = makeHooks();
      await authority.registerLocalRunner(QUEUE_JID, hooks);

      coordination.slots
        .get(liveTurnSlotKey('w1'))
        ?.delete(
          liveTurnSlotHolderId('turn-1', admission.fence.fencingVersion),
        );

      await vi.advanceTimersByTimeAsync(20_000);

      expect(log.stops).toBe(1);
      expect(authority.ownsQueue(QUEUE_JID)).toBe(false);
      expect(warnings).toContain(
        'Live turn ownership lost; stopping local runner',
      );
      await authority.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the local runner when heartbeat verification fails', async () => {
    vi.useFakeTimers();
    try {
      const { authority, coordination, warnings } = makeAuthority();
      const admission = await authority.admit({
        queueJid: QUEUE_JID,
        scope: makeScope(),
        turnId: 'turn-1',
        runId: 'run-1',
      });
      expect(admission.outcome).toBe('claimed');
      if (admission.outcome !== 'claimed') return;
      const { hooks, log } = makeHooks();
      await authority.registerLocalRunner(QUEUE_JID, hooks);
      coordination.heartbeatRunLease = async () => {
        throw new Error('db unavailable');
      };

      await vi.advanceTimersByTimeAsync(20_000);

      expect(log.stops).toBe(1);
      expect(authority.ownsQueue(QUEUE_JID)).toBe(false);
      expect(warnings).toContain(
        'Live turn heartbeat failed; stopping local runner',
      );
      await authority.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports scope_active for duplicate admissions and routes instead', async () => {
    const { authority } = makeAuthority();
    const first = await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    expect(first.outcome).toBe('claimed');
    const second = await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope(),
      turnId: 'turn-2',
      runId: 'run-2',
    });
    expect(second.outcome).toBe('scope_active');
    await authority.finalize(QUEUE_JID, 'completed');
    await authority.shutdown();
  });

  it('writes resolved interaction responses from durable commands', async () => {
    const { authority, liveTurns } = makeAuthority();
    const ipcBaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-live-turn-response-'),
    );
    const envelope = createIpcAuthEnvelope('agent-folder', 'thread-1');
    const privateKey = getIpcResponseSigningPrivateKey(
      'agent-folder',
      'thread-1',
      envelope.responseKeyId,
    );
    expect(privateKey).toBeTruthy();
    revokeIpcResponseSigningKey(
      envelope.responseKeyId,
      'agent-folder',
      'thread-1',
    );
    await authority.admit({
      queueJid: QUEUE_JID,
      scope: makeScope({ threadId: 'thread-1' }),
      turnId: 'turn-1',
      runId: 'run-1',
    });
    await liveTurns.appendLiveTurnCommand({
      id: 'cmd-resolved',
      liveTurnId: 'turn-1',
      commandType: 'interaction_resolved',
      idempotencyKey: 'interaction_resolved:permission:agent-folder:req-1',
      payload: {
        kind: 'permission',
        requestId: 'req-1',
        sourceAgentFolder: 'agent-folder',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        callbackRoute: {
          ipcBaseDir,
          threadId: 'thread-1',
          responseKeyId: envelope.responseKeyId,
          responsePrivateKeySeal: sealIpcResponseSigningPrivateKey(privateKey),
          responseNonce: 'nonce-1',
        },
      },
    });

    await authority.drainQueue(QUEUE_JID);

    expect(liveTurns.commands[0]?.status).toBe('applied');
    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          ipcBaseDir,
          'agent-folder',
          'permission-responses',
          'req-1.json',
        ),
        'utf8',
      ),
    );
    expect(response).toMatchObject({
      requestId: 'req-1',
      responseNonce: 'nonce-1',
      approved: true,
      mode: 'allow_once',
    });
    expect(typeof response.signature).toBe('string');
    await authority.finalize(QUEUE_JID, 'completed');
    await authority.shutdown();
  });
});

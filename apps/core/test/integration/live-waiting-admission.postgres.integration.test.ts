import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

/**
 * Integration coverage for the WP3 waiting-status signal query
 * (getOldestWaitingLiveAdmission), which joins messages + live_turns across the
 * `conversation:` namespace boundary. Runs only under GANTRY_TEST_DATABASE_URL.
 */
maybeDescribe('live waiting admission signal', () => {
  let runtime: PostgresIntegrationRuntime;
  let liveTurns: PostgresIntegrationRuntime['repositories']['liveTurns'];

  const chatJid = 'tg:waiting-room';
  const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_waiting',
    });
    liveTurns = runtime.repositories.liveTurns;
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('reports the oldest inbound message with no covering live turn', async () => {
    // An inbound message arrives; no live turn was ever created for it.
    await runtime.ops.storeMessage({
      id: 'msg-waiting-1',
      chat_jid: chatJid,
      provider: 'telegram',
      sender: 'user-1',
      sender_name: 'User One',
      content: 'hello?',
      timestamp: tenSecondsAgo,
    });

    const waiting = await liveTurns.getOldestWaitingLiveAdmission({
      conversationJids: [chatJid],
    });
    expect(waiting).not.toBeNull();
    expect(waiting?.conversationJid).toBe(chatJid);
    expect(waiting?.ageSeconds).toBeGreaterThanOrEqual(9);
  });

  // The turn is created with an explicitly old createdAt so a later message can
  // be unambiguously newer than the turn's high-water mark.
  const turnCreatedAt = new Date(Date.now() - 6_000).toISOString();

  it('stops reporting once a live turn covers the conversation', async () => {
    // A non-terminal turn now exists for the scope: nothing is waiting (its
    // high-water mark is newer than the only message, the -10s one).
    await liveTurns.claimLiveTurn({
      id: 'turn-waiting-cover',
      scope: {
        appId: 'default',
        agentSessionId: 'session-waiting',
        conversationId: chatJid,
        threadId: null,
      },
      workerInstanceId: 'w-waiting',
      now: turnCreatedAt,
    });

    const waiting = await liveTurns.getOldestWaitingLiveAdmission({
      conversationJids: [chatJid],
    });
    expect(waiting).toBeNull();
  });

  it('reports again when a newer message arrives after the turn completes', async () => {
    // The turn completes; a fresh inbound message arrives AFTER its createdAt.
    const completedAt = new Date(Date.now() - 2_000).toISOString();
    await liveTurns.transitionLiveTurnState({
      id: 'turn-waiting-cover',
      toState: 'completed',
      fromStates: ['claimed'],
      now: completedAt,
    });
    await runtime.ops.storeMessage({
      id: 'msg-waiting-continuation-covered',
      chat_jid: chatJid,
      provider: 'telegram',
      sender: 'user-1',
      sender_name: 'User One',
      content: 'handled during active turn',
      timestamp: new Date(Date.now() - 4_000).toISOString(),
    });
    await runtime.ops.storeMessage({
      id: 'msg-waiting-2',
      chat_jid: chatJid,
      provider: 'telegram',
      sender: 'user-1',
      sender_name: 'User One',
      content: 'still there?',
      timestamp: new Date(Date.now() - 1_000).toISOString(),
    });

    const waiting = await liveTurns.getOldestWaitingLiveAdmission({
      conversationJids: [chatJid],
    });
    expect(waiting).not.toBeNull();
    expect(waiting?.conversationJid).toBe(chatJid);
  });

  it('returns null for conversations not in the routed set', async () => {
    const waiting = await liveTurns.getOldestWaitingLiveAdmission({
      conversationJids: ['tg:some-other-room'],
    });
    expect(waiting).toBeNull();
  });

  it('renders the WP3 live metrics via renderMetrics against real Postgres', async () => {
    const { renderMetrics } =
      await import('@core/control/server/system-health.js');
    const query = async <T>(sql: string): Promise<T[]> => {
      const result = await runtime.service.pool.query(sql);
      return result.rows as T[];
    };
    const body = await renderMetrics({
      query,
      isDraining: () => false,
      uptimeSeconds: () => 1,
      role: 'live-worker',
      liveExecutionEnabled: true,
      currentWorkerInstanceId: () => 'w-waiting',
      oldestWaitingLiveAdmissionSeconds: () => 0,
    });
    // The DB-guarded live gauges executed (no throw → they are emitted).
    expect(body).toContain('gantry_process_role{role="live-worker"} 1');
    expect(body).toContain('gantry_live_turns_active');
    expect(body).toContain('gantry_live_slots_used_cluster');
    expect(body).toContain('gantry_live_turns_recoverable');
    expect(body).toContain('gantry_live_oldest_waiting_seconds 0');
  });
});

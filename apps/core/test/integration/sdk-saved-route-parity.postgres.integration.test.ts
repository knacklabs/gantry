import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import '@core/channels/register-builtins.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { SessionInteractionModule } from '@core/application/sessions/session-interaction-module.js';
import { getTriggerPattern } from '@core/config/index.js';
import { adaptSessionControlPort } from '@core/control/server/session-control-port.js';
import type { LiveAdmissionWorkItem } from '@core/domain/ports/live-turns.js';
import type { ConversationRoute } from '@core/domain/types.js';
import {
  processLiveAdmissionWorkItem,
  type MessageLoopDeps,
} from '@core/runtime/message-loop.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// Fix cold-worker-sdk-routing: the contract is saved-route parity and scope
// isolation. Exact-key-only reload misses real SDK ingress's bare saved key;
// existing route-integrity coverage starts with an already loaded cache.
// This uses existing public ingress/admission APIs, with no production seam.
const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('SDK saved-route parity (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let sessions: SessionInteractionModule;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'sdk_saved_route',
    });
    sessions = new SessionInteractionModule({
      control: adaptSessionControlPort(runtime.control),
      ops: runtime.ops,
      repositories: runtime.repositories,
      runtimeEvents: runtime.storageRuntime.runtimeEvents,
      getTriggerPattern,
      now: () => toIso(nowMs()) as never,
      createId: randomUUID,
      stableHash: (value) => createHash('sha256').update(value).digest('hex'),
    });
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  function worker(cache: Record<string, ConversationRoute> = {}) {
    const wakes: string[] = [];
    const deps: MessageLoopDeps = {
      getConversationRoutes: () => cache,
      getTriggerPattern,
      // Channel presence cannot mask a route-selection failure in this test.
      hasChannel: () => true,
      setTyping: async () => undefined,
      sendProgressUpdate: async () => undefined,
      queue: {
        sendMessage: () => false,
        enqueueMessageCheck: (queueJid) => {
          wakes.push(queueJid);
          return true;
        },
        closeStdin: () => undefined,
      },
      opsRepository: runtime.ops,
    };
    return { cache, deps, wakes };
  }

  it('resolves the same SDK route with empty and warm caches without crossing route scope', async () => {
    const { session, registerGroup } = await sessions.ensureSession({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      conversationId: `sdk-${randomUUID()}`,
    });
    // The control adapter persists ensureSession's returned registration via
    // runtime registerGroup; use that same payload and persistence sink.
    await runtime.ops.setConversationRoute(
      registerGroup.conversationJid,
      registerGroup.group,
    );
    const accept = async (threadId: string): Promise<LiveAdmissionWorkItem> => {
      const accepted = await sessions.acceptMessage(
        {
          appId: DEFAULT_APP_ID,
          sessionId: session.sessionId,
          message: '/gantry status',
          threadId,
        },
        DEFAULT_APP_ID,
      );
      expect(accepted.accepted).toBe(true);
      const items =
        await runtime.repositories.liveTurns.claimLiveAdmissionWorkItems({
          appId: DEFAULT_APP_ID,
          workerInstanceId: 'saved-route-worker',
          claimToken: randomUUID(),
          claimExpiresAt: toIso(nowMs() + 60_000),
          limit: 100,
        });
      const item = items.find(
        (entry) =>
          entry.conversationId === session.conversationJid &&
          entry.threadId === threadId,
      );
      expect(item).toBeDefined();
      if (!item) throw new Error('Expected the accepted SDK admission');
      return item;
    };
    const first = await accept('topic-a');
    const other = await sessions.ensureSession({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      conversationId: `other-${randomUUID()}`,
    });
    await runtime.ops.setConversationRoute(
      other.registerGroup.conversationJid,
      other.registerGroup.group,
    );
    const saved = await runtime.ops.getAllConversationRoutes();
    const route = saved[session.conversationJid];
    expect(route).toMatchObject({
      folder: 'main_agent',
      providerAccountId: 'control:default',
    });
    if (!route) throw new Error('Expected the SDK saved route');
    const canonicalKey = makeAgentThreadQueueKey(
      session.conversationJid,
      session.agentId,
      null,
      route.providerAccountId,
    );
    const cold = worker();
    expect(await processLiveAdmissionWorkItem(cold.deps, first)).toBe(
      'completed',
    );
    expect(cold.wakes).toEqual([first.queueJid]);
    expect(cold.cache).toEqual({
      [session.conversationJid]: route,
      [canonicalKey]: route,
    });

    const second = await accept('topic-b');
    const preloaded = worker({ ...saved });
    expect(await processLiveAdmissionWorkItem(preloaded.deps, second)).toBe(
      'completed',
    );
    expect(preloaded.wakes).toEqual([second.queueJid]);
    // Remove the saved row after ingress. The already warm worker must still
    // serve another thread from the whole-conversation route it selected.
    await runtime.ops.deleteConversationRoute(session.conversationJid);
    expect(await processLiveAdmissionWorkItem(cold.deps, second)).toBe(
      'completed',
    );
    expect(cold.wakes).toEqual([first.queueJid, second.queueJid]);
    const missing = worker();
    expect(await processLiveAdmissionWorkItem(missing.deps, second)).toBe(
      'listener_degraded',
    );
    expect(missing.wakes).toEqual([]);
    expect(missing.cache).toEqual({});

    await runtime.ops.setConversationRoute(session.conversationJid, route);
    // Probe requested identities using the genuine admission, keeping each
    // queue envelope internally consistent so the selector is the rejecting
    // boundary. No synthetic SDK route or admission is persisted.
    for (const mismatch of [
      { agentId: 'agent:another' },
      { providerAccountId: 'control:another' },
      { conversationId: `${session.conversationJid}-another` },
    ]) {
      const probe = { ...first, ...mismatch };
      probe.queueJid = makeAgentThreadQueueKey(
        probe.conversationId,
        probe.agentId,
        probe.threadId,
        probe.providerAccountId,
      );
      for (const cache of [{}, { ...saved }]) {
        const expectedCache = { ...cache };
        const rejected = worker(cache);
        expect(await processLiveAdmissionWorkItem(rejected.deps, probe)).toBe(
          'listener_degraded',
        );
        expect(rejected.wakes).toEqual([]);
        expect(rejected.cache).toEqual(expectedCache);
      }
    }
    const positive = worker();
    expect(await processLiveAdmissionWorkItem(positive.deps, first)).toBe(
      'completed',
    );
    expect(positive.wakes).toEqual([first.queueJid]);

    // SDK ingress only installs whole-conversation routes. Use the existing
    // route API for the additional thread-scoped saved configuration.
    const exactKey = makeAgentThreadQueueKey(
      session.conversationJid,
      session.agentId,
      first.threadId,
      route.providerAccountId,
    );
    const exactRoute = {
      ...route,
      name: 'Topic-specific route',
      trigger: '@topic',
    };
    await runtime.ops.setConversationRoute(exactKey, exactRoute);
    const persistedExact = (await runtime.ops.getAllConversationRoutes())[
      exactKey
    ];
    expect(persistedExact).toBeDefined();
    const exact = worker();
    expect(await processLiveAdmissionWorkItem(exact.deps, first)).toBe(
      'completed',
    );
    expect(exact.wakes).toEqual([first.queueJid]);
    expect(exact.cache).toEqual({ [exactKey]: persistedExact });
    const exactWarm = worker(await runtime.ops.getAllConversationRoutes());
    const parsedTriggers: Array<string | undefined> = [];
    // Command parsing consumes the selected route's trigger, making warm
    // precedence observable even though both routes wake the same queue.
    exactWarm.deps.handleActiveControlCommand = async () => false;
    exactWarm.deps.getTriggerPattern = (trigger) => {
      parsedTriggers.push(trigger);
      return getTriggerPattern(trigger);
    };
    expect(await processLiveAdmissionWorkItem(exactWarm.deps, first)).toBe(
      'completed',
    );
    expect(exactWarm.wakes).toEqual([first.queueJid]);
    expect(parsedTriggers).toEqual(['@topic']);

    // Loading a conversation fallback for topic-b must also retain topic-a's
    // saved override, so the next admission has the fully warm precedence.
    const sequential = worker();
    const sequentialTriggers: Array<string | undefined> = [];
    sequential.deps.handleActiveControlCommand = async () => false;
    sequential.deps.getTriggerPattern = (trigger) => {
      sequentialTriggers.push(trigger);
      return getTriggerPattern(trigger);
    };
    for (const item of [second, first]) {
      expect(await processLiveAdmissionWorkItem(sequential.deps, item)).toBe(
        'completed',
      );
    }
    expect(sequential.wakes).toEqual([second.queueJid, first.queueJid]);
    expect(sequentialTriggers).toEqual([route.trigger, ...parsedTriggers]);
    expect(sequentialTriggers[1]).toBe('@topic');
    expect(sequential.cache).toEqual({
      [session.conversationJid]: route,
      [canonicalKey]: route,
      [exactKey]: persistedExact,
    });

    await runtime.ops.deleteConversationRoute(session.conversationJid);
    const threadRoutes = await runtime.ops.getAllConversationRoutes();
    for (const cache of [{}, { ...threadRoutes }]) {
      const wrongThread = worker(cache);
      expect(await processLiveAdmissionWorkItem(wrongThread.deps, second)).toBe(
        'listener_degraded',
      );
      expect(wrongThread.wakes).toEqual([]);
    }
    const correctThread = worker();
    expect(await processLiveAdmissionWorkItem(correctThread.deps, first)).toBe(
      'completed',
    );
    expect(correctThread.wakes).toEqual([first.queueJid]);
  });
});

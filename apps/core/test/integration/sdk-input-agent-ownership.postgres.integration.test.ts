import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import '@core/channels/register-builtins.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { SessionInteractionModule } from '@core/application/sessions/session-interaction-module.js';
import { adaptSessionControlPort } from '@core/control/server/session-control-port.js';
import { getTriggerPattern } from '@core/config/index.js';
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

// Fix sdk-chat-admission: real session ingress and Postgres own these regressions.
// Existing quiet-window coverage checks scheduling delay, not producer ownership
// or routing on a separate worker with an empty local cache. No new runtime seam.
const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
maybeDescribe('SDK input agent ownership (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let sessions: SessionInteractionModule;
  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'sdk_ownership',
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

  async function accept(threadId: string | null = null) {
    const ensured = await sessions.ensureSession({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      conversationId: `sdk-${randomUUID()}`,
    });
    await runtime.ops.setConversationRoute(
      ensured.registerGroup.conversationJid,
      ensured.registerGroup.group,
    );
    const accepted = await sessions.acceptMessage(
      {
        appId: DEFAULT_APP_ID,
        sessionId: ensured.session.sessionId,
        // A real SDK session command bypasses batching without sleeps or row edits.
        message: '/gantry status',
        threadId,
      },
      DEFAULT_APP_ID,
    );
    expect(accepted.accepted).toBe(true);
    const items =
      await runtime.repositories.liveTurns.claimLiveAdmissionWorkItems({
        appId: DEFAULT_APP_ID,
        workerInstanceId: 'sdk-worker',
        claimToken: randomUUID(),
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 100,
      });
    const item = items.find(
      (candidate) =>
        candidate.conversationId === ensured.session.conversationJid,
    );
    expect(item).toBeDefined();
    if (!item) throw new Error('SDK admission was not found');
    return { ...ensured, item };
  }

  it('takes accepted SDK input exactly once for its bound agent and session', async () => {
    const { session, item } = await accept('topic-1');
    const scope = {
      appId: DEFAULT_APP_ID,
      conversationId: session.conversationJid,
      threadId: 'topic-1',
      agentId: session.agentId,
      providerAccountId: 'control:default',
    };
    // Each denial differs in exactly one boundary; the positive control below
    // proves these are not empty results caused by a missing admission.
    for (const mismatch of [
      { providerAccountId: 'control:another' },
      { agentId: 'agent:another' },
      { conversationId: `${session.conversationJid}-another` },
      { threadId: 'topic-2' },
    ]) {
      expect(
        await runtime.repositories.liveTurns.takeInput({
          scope: { ...scope, ...mismatch },
          consumedBy: 'other-worker',
          limit: 10,
        }),
      ).toEqual([]);
    }
    const taken = await runtime.repositories.liveTurns.takeInput({
      scope,
      consumedBy: 'bound-worker',
      limit: 10,
    });
    expect(taken).toMatchObject([
      {
        id: item.id,
        agentId: session.agentId,
        agentSessionId: session.sessionId,
        consumedBy: 'bound-worker',
      },
    ]);
    expect(
      await runtime.repositories.liveTurns.takeInput({
        scope,
        consumedBy: 'second-worker',
        limit: 10,
      }),
    ).toEqual([]);
  });

  it('finds a persisted SDK route on a cold worker without a recovery sweep', async () => {
    const { session, item } = await accept();
    const routes: Record<string, ConversationRoute> = {};
    const wakes: string[] = [];
    const deps: MessageLoopDeps = {
      getConversationRoutes: () => routes,
      getTriggerPattern,
      hasChannel: (jid, options) =>
        jid === session.conversationJid &&
        options?.providerAccountId === 'control:default',
      setTyping: async () => undefined,
      sendProgressUpdate: async () => undefined,
      opsRepository: runtime.ops,
      queue: {
        enqueueMessageCheck: (jid) => {
          wakes.push(jid);
        },
        sendMessage: () => false,
        closeStdin: () => undefined,
      },
    };
    // Do not preload routes or repair the SDK admission before worker lookup.
    expect(await processLiveAdmissionWorkItem(deps, item)).toBe('completed');
    expect(wakes).toEqual([
      makeAgentThreadQueueKey(
        session.conversationJid,
        session.agentId,
        null,
        'control:default',
      ),
    ]);
    expect(Object.values(routes)).toContainEqual(
      expect.objectContaining({
        folder: 'main_agent',
        providerAccountId: 'control:default',
      }),
    );
  });

  it.each(['provider', 'agent', 'chat', 'thread', 'missing'] as const)(
    'keeps a cold worker closed for a %s route mismatch',
    async (boundary) => {
      const { session, registerGroup, item } = await accept();
      await runtime.ops.deleteConversationRoute(session.conversationJid);
      if (boundary !== 'missing') {
        const jid =
          boundary === 'chat'
            ? `${session.conversationJid}-other`
            : session.conversationJid;
        const key =
          boundary === 'thread'
            ? makeAgentThreadQueueKey(
                jid,
                session.agentId,
                'other-topic',
                'control:default',
              )
            : jid;
        await runtime.ops.setConversationRoute(key, {
          ...registerGroup.group,
          ...(boundary === 'provider'
            ? {
                providerAccountId: 'control:another',
                conversationId: undefined,
              }
            : {}),
          ...(boundary === 'agent' ? { folder: 'another_agent' } : {}),
        });
      }
      const wakes: string[] = [];
      const deps = {
        getConversationRoutes: () => ({}),
        getTriggerPattern,
        hasChannel: () => true,
        opsRepository: runtime.ops,
        queue: {
          enqueueMessageCheck: (jid: string) => {
            wakes.push(jid);
          },
        },
      } as MessageLoopDeps;
      expect(await processLiveAdmissionWorkItem(deps, item)).toBe(
        'listener_degraded',
      );
      expect(wakes).toEqual([]);
    },
  );
});

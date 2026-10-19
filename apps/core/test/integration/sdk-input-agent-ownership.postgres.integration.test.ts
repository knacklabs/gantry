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
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// Fix sdk-chat-admission: real session ingress and Postgres own this regression.
// Existing quiet-window coverage checks batching, not producer ownership.
// No new runtime seam is needed to observe the accepted input being taken.
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

  it('takes accepted SDK input exactly once for its bound agent and session', async () => {
    const threadId = 'topic-1';
    const { session } = await sessions.ensureSession({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      conversationId: `sdk-${randomUUID()}`,
    });
    const accepted = await sessions.acceptMessage(
      {
        appId: DEFAULT_APP_ID,
        sessionId: session.sessionId,
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
      (candidate) => candidate.conversationId === session.conversationJid,
    );
    expect(item).toBeDefined();
    if (!item) throw new Error('SDK admission was not found');
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
});

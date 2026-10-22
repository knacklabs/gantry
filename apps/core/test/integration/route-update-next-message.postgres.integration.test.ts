import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import '@core/channels/register-builtins.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { createRuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { SessionInteractionModule } from '@core/application/sessions/session-interaction-module.js';
import { getTriggerPattern } from '@core/config/index.js';
import { adaptSessionControlPort } from '@core/control/server/session-control-port.js';
import type { ConversationRoute } from '@core/domain/types.js';
import {
  processLiveAdmissionWorkItem,
  type MessageLoopDeps,
} from '@core/runtime/message-loop.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import { createFakeChannelRuntime } from '../harness/fake-channel.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// Fix recovered-route-settings: saved-route parity never mutates a recovered
// worker. Observe current configuration at actual execution, without a cache
// reset or a new production seam; only the channel and model are faked.
const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
maybeDescribe('Route update next-message settings (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let sessions: SessionInteractionModule;
  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'route_update',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
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

  it('uses current route settings on the next message after cold recovery and each successful update', async () => {
    const { session, registerGroup } = await sessions.ensureSession({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      conversationId: `settings-${randomUUID()}`,
    });
    const registration: ConversationRoute = {
      ...registerGroup.group,
      trigger: '@original',
      agentConfig: { permissionMode: 'auto' },
    };
    await runtime.ops.setConversationRoute(
      session.conversationJid,
      registration,
    );
    const original = (await runtime.ops.getAllConversationRoutes())[
      session.conversationJid
    ];
    if (!original) throw new Error('Expected persisted SDK route');
    const calls: Array<{
      trigger: string;
      permissionMode: string | undefined;
    }> = [];
    const app = createRuntimeApp({
      opsRepository: runtime.ops,
      runAgent: async (group, _input, _onProcess, onOutput) => {
        calls.push({
          trigger: group.trigger,
          permissionMode: group.agentConfig?.permissionMode,
        });
        const output = {
          status: 'success' as const,
          result: `Reply ${calls.length}`,
        };
        await onOutput?.(output);
        return output;
      },
    });
    const channel = createFakeChannelRuntime(
      (jid) => jid === session.conversationJid,
    );
    app.setChannelRuntime(channel.runtime);
    const deps: MessageLoopDeps = {
      getConversationRoutes: app.getConversationRoutes,
      getTriggerPattern,
      hasChannel: channel.runtime.hasChannel,
      setTyping: channel.runtime.setTyping,
      sendProgressUpdate: channel.runtime.sendProgressUpdate,
      queue: app.queue,
      opsRepository: runtime.ops,
    };
    // Admission queues real work, but this test drains it explicitly below.
    // No queue processor is installed, so no hidden turn races the assertions.
    const accept = async (message: string) => {
      const accepted = await sessions.acceptMessage(
        {
          appId: session.appId,
          sessionId: session.sessionId,
          message,
        },
        session.appId,
      );
      expect(accepted.accepted).toBe(true);
      // Advance only the database-owned batching deadline, never admission or
      // consumption state, so real ingress and takeInput still own execution.
      await runtime.service.pool.query(
        `UPDATE "${runtime.schemaName}".live_admission_work_items SET defer_until = clock_timestamp() WHERE conversation_id = $1 AND state = 'deferred' AND deferred_reason = 'quiet_window'`,
        [session.conversationJid],
      );
      const items =
        await runtime.repositories.liveTurns.claimLiveAdmissionWorkItems({
          appId: session.appId,
          workerInstanceId: 'route-update-worker',
          claimToken: randomUUID(),
          claimExpiresAt: toIso(nowMs() + 60_000),
          limit: 100,
        });
      const item = items.find(
        (entry) => entry.conversationId === session.conversationJid,
      );
      expect(item).toBeDefined();
      if (!item) throw new Error('Expected genuine SDK admission');
      expect(await processLiveAdmissionWorkItem(deps, item)).toBe('completed');
      expect(
        await app.processGroupMessages(item.queueJid, {
          admissionAppId: session.appId,
        }),
      ).toBe(true);
    };
    await accept('/gantry status');
    expect(calls).toEqual([]);
    const canonicalKey = makeAgentThreadQueueKey(
      session.conversationJid,
      session.agentId,
      null,
      original.providerAccountId,
    );
    expect(Object.keys(app.getConversationRoutes())).toEqual(
      expect.arrayContaining([session.conversationJid, canonicalKey]),
    );

    await app.registerGroup(session.conversationJid, {
      ...original,
      trigger: '@updated',
      agentConfig: { permissionMode: 'ask' },
    });
    expect(
      (await runtime.ops.getAllConversationRoutes())[session.conversationJid],
    ).toMatchObject({
      trigger: '@updated',
      agentConfig: { permissionMode: 'ask' },
    });
    await accept('Use the updated route.');
    expect(calls).toEqual([{ trigger: '@updated', permissionMode: 'ask' }]);

    // An override addressed through the qualified key must also refresh the
    // saved-key alias; another public registration must not resurrect it.
    await app.setGroupPermissionModeOverride(canonicalKey, 'auto');
    await accept('Use the updated override.');
    expect(calls.at(-1)).toEqual({
      trigger: '@updated',
      permissionMode: 'auto',
    });
    await app.setGroupPermissionModeOverride(session.conversationJid, 'ask');
    await accept('Use the saved-key override.');
    expect(calls.at(-1)).toEqual({
      trigger: '@updated',
      permissionMode: 'ask',
    });
    await app.registerGroup(session.conversationJid, {
      ...original,
      trigger: '@final',
    });
    await accept('Use the final route.');
    expect(calls).toEqual([
      { trigger: '@updated', permissionMode: 'ask' },
      { trigger: '@updated', permissionMode: 'auto' },
      { trigger: '@updated', permissionMode: 'ask' },
      { trigger: '@final', permissionMode: 'auto' },
    ]);
    expect(channel.outbound.map((entry) => entry.text)).toEqual(
      expect.arrayContaining(['Reply 1', 'Reply 2', 'Reply 3', 'Reply 4']),
    );
  });
});

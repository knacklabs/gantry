import { describe, expect, it, vi } from 'vitest';

import {
  SessionInteractionModule,
  makeAppGroup,
} from '@core/application/sessions/session-interaction-module.js';

function makeModule(overrides?: {
  control?: Record<string, unknown>;
  ops?: Record<string, unknown>;
  repositories?: Record<string, unknown>;
  runtimeEvents?: Record<string, unknown>;
  liveAdmissionAppId?: string | null;
  getConfiguredAgentRuntime?: (
    agentFolder: string,
  ) => 'worker' | 'inline' | undefined;
}) {
  const control = {
    ensureAppSession: vi.fn(async (input) => ({
      sessionId: 'session-1',
      appId: input.appId,
      conversationId: input.conversationId,
      conversationJid: input.conversationJid,
      workspaceKey: input.folder,
      defaultResponseMode: input.defaultResponseMode ?? 'sse',
      defaultWebhookId: input.defaultWebhookId ?? null,
    })),
    getWebhookById: vi.fn(),
    getAppSessionById: vi.fn(async () => ({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      conversationJid: 'app:app-one:conv-1',
      workspaceKey: 'group',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    })),
    upsertAppResponseRoute: vi.fn(async () => ({
      responseMode: 'sse',
      webhookId: null,
      correlationId: null,
    })),
    getAppSessionByChatJid: vi.fn(),
    getAppResponseRoute: vi.fn(),
    ...overrides?.control,
  };
  const runtimeEvents = {
    publish: vi.fn(async () => ({ eventId: 1001 })),
    list: vi.fn(async () => []),
    subscribe: vi.fn(async () => ({
      next: vi.fn(async () => []),
      close: vi.fn(),
    })),
    ...overrides?.runtimeEvents,
  };
  const ops = {
    storeChatMetadata: vi.fn(async () => undefined),
    storeMessage: vi.fn(async () => undefined),
    ...overrides?.ops,
  };
  const module = new SessionInteractionModule({
    control: control as never,
    ops: ops as never,
    repositories: (overrides?.repositories ?? {}) as never,
    runtimeEvents: runtimeEvents as never,
    liveAdmissionAppId: overrides?.liveAdmissionAppId,
    getConfiguredAgentRuntime:
      overrides?.getConfiguredAgentRuntime ?? vi.fn(() => 'inline'),
    now: () => '2026-04-30T00:00:00.000Z' as never,
    createId: () => 'id-1',
    stableHash: () => '123456789abc',
  });
  return { module, control, ops, runtimeEvents };
}

describe('SessionInteractionModule', () => {
  it('marks app-session groups as web_user identity routes with sdk as the system sender sentinel', () => {
    expect(
      makeAppGroup({
        appId: 'app-one',
        conversationId: 'conv-1',
        conversationJid: 'app:app-one:conv-1',
        identityHash: '123456789abc',
        addedAt: '2026-04-30T00:00:00.000Z',
      }),
    ).toMatchObject({
      senderIdentityEvidenceType: 'web_user',
      systemSenderIds: ['sdk'],
    });
  });

  it('rejects non-canonical conversation ids before creating app chat ids', async () => {
    const { module, control } = makeModule();

    await expect(
      module.ensureSession({
        appId: 'app-one',
        conversationId: 'bad:conversation',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message:
        'appId and conversationId must contain only letters, numbers, dot, underscore, or dash',
    });
    expect(control.ensureAppSession).not.toHaveBeenCalled();
  });

  it('binds an SDK session to one immutable app user assertion', async () => {
    const { module, control } = makeModule({
      control: {
        getAppSessionById: vi.fn(async () => ({
          sessionId: 'session-1',
          appId: 'app-one',
          conversationId: 'conv-1',
          conversationJid: 'app:app-one:conv-1',
          workspaceKey: 'group',
          defaultResponseMode: 'sse',
          defaultWebhookId: null,
          appUser: { authorityId: 'web-app', subject: 'user-1' },
        })),
      },
    });

    await module.ensureSession({
      appId: 'app-one',
      conversationId: 'conv-1',
      conversationKind: 'dm',
      appUser: { authorityId: 'web-app', subject: 'user-1' },
    });
    expect(control.ensureAppSession).toHaveBeenCalledWith(
      expect.objectContaining({
        appUser: { authorityId: 'web-app', subject: 'user-1' },
      }),
    );

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'hello',
        senderId: 'user-2',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'SDK session is bound to a different app user.',
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'anonymous message',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'SDK session is bound to a different app user.',
    });
  });

  it('rejects waits for sessions outside the authenticated app', async () => {
    const { module, runtimeEvents } = makeModule({
      control: {
        getAppSessionById: vi.fn(async () => ({
          sessionId: 'session-1',
          appId: 'app-two',
          conversationId: 'conv-1',
          conversationJid: 'app:app-two:conv-1',
          workspaceKey: 'group',
          defaultResponseMode: 'sse',
          defaultWebhookId: null,
        })),
      },
    });

    await expect(
      module.waitForVisibleEvent({
        appId: 'app-one',
        sessionId: 'session-1',
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'API key cannot access this session',
    });
    expect(runtimeEvents.subscribe).not.toHaveBeenCalled();
  });

  it('redacts provider session identifiers from default session details', async () => {
    const { module } = makeModule({
      repositories: {
        agentSessions: {
          getAgentSession: vi.fn(async () => ({
            id: 'session-1',
            appId: 'app-one',
            agentId: 'agent-one',
            conversationId: 'conv-1',
            status: 'active',
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
        },
        providerSessions: {
          getLatestProviderSession: vi.fn(async () => ({
            id: 'provider-session-sdk-resume-handle',
            appId: 'app-one',
            agentSessionId: 'session-1',
            provider: 'anthropic',
            externalSessionId: 'claude-session-secret',
            providerRef: {
              kind: 'provider_session',
              value: 'anthropic:claude-session-secret',
            },
            status: 'active',
            metadata: { resumeHandle: 'claude-session-secret' },
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
        },
      },
    });

    const details = (await module.getSessionDetails({
      appId: 'app-one',
      sessionId: 'session-1',
    })) as { providerSession: Record<string, unknown> | null };

    expect(details.providerSession).toMatchObject({
      provider: 'anthropic',
      status: 'active',
      hasProviderResume: true,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(details.providerSession).not.toHaveProperty('id');
    expect(details.providerSession).not.toHaveProperty('appId');
    expect(details.providerSession).not.toHaveProperty('agentSessionId');
    expect(details.providerSession).not.toHaveProperty('externalSessionId');
    expect(details.providerSession).not.toHaveProperty('providerRef');
    expect(details.providerSession).not.toHaveProperty('metadata');
  });

  it('stores accepted SDK messages with durable live admission work', async () => {
    const order: string[] = [];
    const publish = vi.fn();
    const publishWithLiveAdmissionMessage = vi.fn(async (_event, admission) => {
      order.push('publishAcceptedEventAndStoreAdmission');
      expect(admission).toMatchObject({
        message: {
          chat_jid: 'app:app-one:conv-1',
          content: 'hello from sdk',
          responseSchema: {
            type: 'object',
            required: ['answer'],
          },
          agentControls: {
            effort: 'high',
            thinking: { mode: 'on', budgetTokens: 1024 },
            maxOutputTokens: 4096,
          },
        },
        liveAdmission: {
          appId: 'default',
          triggerDecision: {
            source: 'sdk_session',
            responseMode: 'webhook',
          },
          now: '2026-04-30T00:00:00.000Z',
        },
      });
      return {
        event: { eventId: 1001 },
        liveAdmissionResult: {
          outcome: 'enqueued',
          item: { id: 'admission-1', state: 'queued' },
        },
      };
    });
    const { module, ops } = makeModule({
      liveAdmissionAppId: 'default',
      control: {
        upsertAppResponseRoute: vi.fn(async () => {
          order.push('upsertAppResponseRoute');
          return {
            responseMode: 'webhook',
            webhookId: null,
            correlationId: 'corr-1',
          };
        }),
      },
      ops: {
        notifyLiveAdmissionWorkItem: vi.fn(async () => {
          order.push('notifyLiveAdmissionWorkItem');
        }),
      },
      runtimeEvents: {
        publish,
        publishWithLiveAdmissionMessage,
      },
    });

    const accepted = await module.acceptMessage({
      appId: 'app-one',
      sessionId: 'session-1',
      message: 'hello from sdk',
      threadId: 'thread-1',
      responseMode: 'webhook',
      senderId: 'user-1',
      senderName: 'User One',
      correlationId: 'corr-1',
      responseSchema: {
        type: 'object',
        required: ['answer'],
      },
      agentControls: {
        effort: 'high',
        thinking: { mode: 'on', budgetTokens: 1024 },
        maxOutputTokens: 4096,
      },
      beforeDurableAdmission: async () => {
        order.push('beforeDurableAdmission');
      },
    });

    expect(order).toEqual([
      'upsertAppResponseRoute',
      'beforeDurableAdmission',
      'publishAcceptedEventAndStoreAdmission',
      'notifyLiveAdmissionWorkItem',
    ]);
    expect(publish).not.toHaveBeenCalled();
    expect(ops.storeMessage).not.toHaveBeenCalled();
    expect(accepted.enqueue).toEqual({
      conversationJid: 'app:app-one:conv-1',
      threadId: 'thread-1',
      queueKey: 'app:app-one:conv-1::thread:thread-1',
      durableAdmissionCreated: true,
    });
  });

  it('rejects response schemas for worker runtimes before persistence or durable admission', async () => {
    const getConfiguredAgentRuntime = vi.fn(() => 'worker' as const);
    const publishWithLiveAdmissionMessage = vi.fn();
    const { module, control, ops, runtimeEvents } = makeModule({
      getConfiguredAgentRuntime,
      runtimeEvents: { publishWithLiveAdmissionMessage },
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'hello from sdk',
        responseSchema: { type: 'object' },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'response_schema requires an inline agent runtime',
    });

    expect(getConfiguredAgentRuntime).toHaveBeenCalledWith('group');
    expect(ops.storeChatMetadata).not.toHaveBeenCalled();
    expect(control.upsertAppResponseRoute).not.toHaveBeenCalled();
    expect(ops.storeMessage).not.toHaveBeenCalled();
    expect(publishWithLiveAdmissionMessage).not.toHaveBeenCalled();
    expect(runtimeEvents.publish).not.toHaveBeenCalled();
  });

  it('rejects response schemas when no settings agent entry resolves', async () => {
    const getConfiguredAgentRuntime = vi.fn(() => undefined);
    const { module, control, ops, runtimeEvents } = makeModule({
      getConfiguredAgentRuntime,
      liveAdmissionAppId: null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'hello from sdk',
        responseSchema: { type: 'object' },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'response_schema requires an inline agent runtime',
    });

    expect(getConfiguredAgentRuntime).toHaveBeenCalledWith('group');
    expect(ops.storeChatMetadata).not.toHaveBeenCalled();
    expect(control.upsertAppResponseRoute).not.toHaveBeenCalled();
    expect(ops.storeMessage).not.toHaveBeenCalled();
    expect(runtimeEvents.publish).not.toHaveBeenCalled();
  });

  it('accepts and persists response schemas for inline runtimes', async () => {
    const getConfiguredAgentRuntime = vi.fn(() => 'inline' as const);
    const { module, ops } = makeModule({
      getConfiguredAgentRuntime,
      liveAdmissionAppId: null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'hello from sdk',
        responseSchema: { type: 'object' },
      }),
    ).resolves.toMatchObject({ accepted: true });

    expect(getConfiguredAgentRuntime).toHaveBeenCalledWith('group');
    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        responseSchema: { type: 'object' },
      }),
    );
  });

  it('falls back to plain message storage when durable live admission is disabled', async () => {
    const storeMessageWithLiveAdmission = vi.fn(async () => ({
      outcome: 'enqueued',
      item: {},
    }));
    const { module, ops } = makeModule({
      liveAdmissionAppId: null,
      ops: { storeMessageWithLiveAdmission },
    });

    const accepted = await module.acceptMessage({
      appId: 'app-one',
      sessionId: 'session-1',
      message: 'hello from sdk',
      responseSchema: { type: 'object' },
    });

    expect(storeMessageWithLiveAdmission).not.toHaveBeenCalled();
    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'hello from sdk',
        responseSchema: { type: 'object' },
      }),
    );
    expect(accepted.enqueue.durableAdmissionCreated).toBe(false);
  });

  it('summarizes provider resume state without exposing raw metadata handles', async () => {
    const { module } = makeModule({
      repositories: {
        agentSessions: {
          getAgentSession: vi.fn(async () => ({
            id: 'session-1',
            appId: 'app-one',
            agentId: 'agent-one',
            conversationId: 'conv-1',
            status: 'active',
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
        },
        providerSessions: {
          getLatestProviderSession: vi.fn(async () => ({
            id: 'provider-session-opaque',
            appId: 'app-one',
            agentSessionId: 'session-1',
            provider: 'anthropic',
            externalSessionId: '',
            providerRef: {
              kind: 'provider_session',
              value: '',
            },
            status: 'active',
            metadata: {
              resume: {
                session_id: 'short-handle-from-metadata',
              },
            },
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
        },
      },
    });

    const details = (await module.getSessionDetails({
      appId: 'app-one',
      sessionId: 'session-1',
    })) as { providerSession: Record<string, unknown> | null };

    expect(details.providerSession).toMatchObject({
      provider: 'anthropic',
      status: 'active',
      hasProviderResume: true,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(JSON.stringify(details.providerSession)).not.toContain(
      'short-handle-from-metadata',
    );
    expect(details.providerSession).not.toHaveProperty('externalSessionId');
    expect(details.providerSession).not.toHaveProperty('providerRef');
    expect(details.providerSession).not.toHaveProperty('metadata');
  });

  it('times out session waits and closes the subscription', async () => {
    const close = vi.fn();
    const next = vi.fn(async () => []);
    const { module, runtimeEvents } = makeModule({
      runtimeEvents: {
        subscribe: vi.fn(async () => ({ next, close })),
      },
    });

    await expect(
      module.waitForVisibleEvent({
        appId: 'app-one',
        sessionId: 'session-1',
        afterEventId: 9,
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({
      code: 'WAIT_TIMEOUT',
      message: 'Timed out waiting for session event',
    });
    expect(runtimeEvents.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        sessionId: 'session-1',
        afterEventId: 9,
      }),
    );
    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { SessionInteractionModule } from '@core/application/sessions/session-interaction-module.js';

function makeModule(overrides?: {
  control?: Record<string, unknown>;
  repositories?: Record<string, unknown>;
  runtimeEvents?: Record<string, unknown>;
}) {
  const control = {
    ensureAppSession: vi.fn(async (input) => ({
      sessionId: 'session-1',
      appId: input.appId,
      conversationId: input.conversationId,
      chatJid: input.chatJid,
      workspaceKey: input.folder,
      defaultResponseMode: input.defaultResponseMode ?? 'sse',
      defaultWebhookId: input.defaultWebhookId ?? null,
    })),
    getWebhookById: vi.fn(),
    getAppSessionById: vi.fn(async () => ({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationId: 'conv-1',
      chatJid: 'app:app-one:conv-1',
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
  const module = new SessionInteractionModule({
    control: control as never,
    ops: {
      storeChatMetadata: vi.fn(async () => undefined),
      storeMessage: vi.fn(async () => undefined),
    } as never,
    repositories: (overrides?.repositories ?? {}) as never,
    runtimeEvents: runtimeEvents as never,
    now: () => '2026-04-30T00:00:00.000Z' as never,
    createId: () => 'id-1',
    stableHash: () => '123456789abc',
  });
  return { module, control, runtimeEvents };
}

describe('SessionInteractionModule', () => {
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

  it('rejects waits for sessions outside the authenticated app', async () => {
    const { module, runtimeEvents } = makeModule({
      control: {
        getAppSessionById: vi.fn(async () => ({
          sessionId: 'session-1',
          appId: 'app-two',
          conversationId: 'conv-1',
          chatJid: 'app:app-two:conv-1',
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
            latestArtifactId: 'provider-artifact-secret',
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
    expect(details.providerSession).not.toHaveProperty('latestArtifactId');
    expect(details.providerSession).not.toHaveProperty('metadata');
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
            latestArtifactId: '',
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
    expect(details.providerSession).not.toHaveProperty('latestArtifactId');
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

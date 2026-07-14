import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ExternalIngressModule } from '@core/application/external-ingress/external-ingress-module.js';
import { EXTERNAL_INGRESS_RUNTIME_DISPATCH } from '@core/application/external-ingress/runtime-dispatch.js';
import { signExternalIngressRequest } from '@core/application/external-ingress/signature.js';

const signatureCrypto = {
  sha256: (input: string) => createHash('sha256').update(input).digest('hex'),
  hmacSha256: (secret: string, payload: string) =>
    createHmac('sha256', secret).update(payload).digest('hex'),
  constantTimeEqual: (left: string, right: string) => {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  },
};

function signedInvokeInput(input: {
  secret: string;
  ingressId?: string;
  rawBody: string;
  method?: string;
  nonce?: string;
  timestamp?: string;
  path?: string;
}) {
  const ingressId = input.ingressId ?? 'ingress-1';
  const method = input.method ?? 'POST';
  const nonce = input.nonce ?? 'nonce-1';
  const timestamp = input.timestamp ?? String(Date.now());
  const path = input.path ?? `/v1/ingresses/${ingressId}/invoke`;
  const signature = signExternalIngressRequest({
    crypto: signatureCrypto,
    secret: input.secret,
    method,
    path,
    timestamp,
    nonce,
    rawBody: input.rawBody,
  }).signature;
  return {
    ingressId,
    method,
    path,
    timestamp,
    nonce,
    signature,
    rawBody: input.rawBody,
  };
}

function makeModule(overrides?: {
  control?: Partial<ExternalIngressControl>;
  sessions?: Partial<ExternalIngressSessions>;
  conversationMessages?: Partial<ExternalIngressConversationMessages>;
  conversationProviderMessages?: Partial<ExternalIngressConversationProviderMessages>;
  jobs?: Partial<ExternalIngressJobs>;
  metadata?: unknown;
}) {
  const control: ExternalIngressControl = {
    createExternalIngress: vi.fn(async (input) => ({
      ingressId: 'ingress-created',
      appId: input.appId,
      name: input.name,
      secret: input.secret,
      enabled: input.enabled ?? true,
      metadata: input.metadata ?? {},
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    })),
    listExternalIngresses: vi.fn(),
    getExternalIngressById: vi.fn(async () => ({
      ingressId: 'ingress-1',
      appId: 'app-one',
      name: 'main',
      secret: 'secret-1',
      enabled: true,
      metadata: overrides?.metadata ?? {
        targetPolicy: {
          allowedTargetKinds: [
            'session_message',
            'job_trigger',
            'job_template',
          ],
          conversationIds: ['conv-1'],
          sessionIds: ['session-1'],
          jobIds: ['job-1'],
          templateIds: ['template-1'],
        },
        templates: {
          'template-1': {
            name: 'Template job',
            prompt: 'Solve {{task}}',
            sessionId: 'session-1',
            allowedVariables: ['task'],
          },
        },
      },
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    })),
    updateExternalIngress: vi.fn(),
    deleteExternalIngress: vi.fn(),
    reserveExternalIngressNonce: vi.fn(async () => ({ ok: true as const })),
    getExternalIngressInvocationByIdempotencyKey: vi.fn(async () => undefined),
    createExternalIngressInvocation: vi.fn(async (input) => ({
      created: true,
      row: {
        invocationId: input.invocationId,
        status: 'pending',
        bodyHash: input.bodyHash,
        response: null,
        error: null,
        updatedAt: input.now,
      },
    })),
    updateExternalIngressInvocation: vi.fn(async () => undefined),
    getExternalIngressInvocation: vi.fn(async () => ({
      invocationId: 'invocation-1',
      status: 'completed',
      bodyHash: 'hash',
      response: { ok: true },
      error: null,
      updatedAt: '2026-04-30T00:00:00.000Z',
    })),
    ...overrides?.control,
  };

  const sessions: ExternalIngressSessions = {
    ensureSession: vi.fn(async () => ({
      session: {
        sessionId: 'session-1',
      },
      registerGroup: {
        conversationJid: 'app:app-one:conv-1',
        group: {
          name: 'app-one:conv-1',
          folder: 'app_conv_1',
          trigger: '',
          added_at: '2026-04-30T00:00:00.000Z',
          requiresTrigger: false,
        },
      },
    })),
    acceptMessage: vi.fn(async (input) => {
      await input.beforeDurableAdmission?.();
      return {
        accepted: true,
        messageId: 'message-1',
        acceptedEventId: 101,
        enqueue: {
          conversationJid: 'app:app-one:conv-1',
          threadId: null,
          queueKey: 'app:app-one:conv-1',
          durableAdmissionCreated: input.durableLiveAdmission !== false,
        },
      };
    }),
    ...overrides?.sessions,
  };

  const jobs: ExternalIngressJobs = {
    triggerJob: vi.fn(async () => ({ triggerId: 'trigger-1' })),
    createJob: vi.fn(),
    ...overrides?.jobs,
  };
  const conversationMessages: ExternalIngressConversationMessages = {
    acceptMessage: vi.fn(async () => ({
      messageId: 'conversation-message-1',
      conversationId: 'conversation:tg:-100',
      threadId: 'thread:tg:-100:42',
      acceptedEventId: 202,
      enqueue: {
        conversationJid: 'tg:-100',
        threadId: '42',
        providerAccountId: 'channel-providerAccount:app-one:telegram',
        queueKey: 'tg:-100::thread:42',
        durableAdmissionCreated: true,
      },
    })),
    ...overrides?.conversationMessages,
  };
  const conversationProviderMessages:
    | ExternalIngressConversationProviderMessages
    | undefined = overrides?.conversationProviderMessages
    ? ({
        send: vi.fn(async () => undefined),
        ...overrides.conversationProviderMessages,
      } as ExternalIngressConversationProviderMessages)
    : undefined;
  const registerSessionGroup = vi.fn(async () => undefined);

  const module = new ExternalIngressModule({
    control: control as never,
    sessions: sessions as never,
    registerSessionGroup,
    conversationMessages: conversationMessages as never,
    conversationProviderMessages: conversationProviderMessages as never,
    jobs: jobs as never,
    now: () => '2026-04-30T00:00:00.000Z',
    createSecret: () => 'secret-generated',
    createInvocationId: () => 'invocation-new',
    signatureCrypto,
    perAppTriggerLimit: 5,
    perJobTriggerLimit: 2,
  });

  return {
    module,
    control,
    sessions,
    registerSessionGroup,
    conversationMessages,
    conversationProviderMessages,
    jobs,
  };
}

type ExternalIngressControl = {
  createExternalIngress: ReturnType<typeof vi.fn>;
  listExternalIngresses: ReturnType<typeof vi.fn>;
  getExternalIngressById: ReturnType<typeof vi.fn>;
  updateExternalIngress: ReturnType<typeof vi.fn>;
  deleteExternalIngress: ReturnType<typeof vi.fn>;
  reserveExternalIngressNonce: ReturnType<typeof vi.fn>;
  getExternalIngressInvocationByIdempotencyKey: ReturnType<typeof vi.fn>;
  createExternalIngressInvocation: ReturnType<typeof vi.fn>;
  updateExternalIngressInvocation: ReturnType<typeof vi.fn>;
  getExternalIngressInvocation: ReturnType<typeof vi.fn>;
};

type ExternalIngressSessions = {
  ensureSession: ReturnType<typeof vi.fn>;
  acceptMessage: ReturnType<typeof vi.fn>;
};

type ExternalIngressConversationMessages = {
  acceptMessage: ReturnType<typeof vi.fn>;
};

type ExternalIngressConversationProviderMessages = {
  send: ReturnType<typeof vi.fn>;
};

type ExternalIngressJobs = {
  triggerJob: ReturnType<typeof vi.fn>;
  createJob: ReturnType<typeof vi.fn>;
};

describe('ExternalIngressModule', () => {
  it('validates metadata before creating durable ingress state', async () => {
    const { module, control } = makeModule();

    await expect(
      module.create({
        appId: 'app-one',
        name: 'bad-metadata',
        metadata: {
          targetPolicy: {
            allowedTargetKinds: ['job_template'],
            templateIds: ['template-1'],
          },
          templates: {
            'template-1': {
              name: 'Template',
              prompt: 'Run {{task}}',
              sessionId: 'session-1',
              allowedVariables: ['task'],
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      secret: 'secret-generated',
    });
    expect(control.createExternalIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          targetPolicy: expect.objectContaining({
            allowedTargetKinds: ['job_template'],
          }),
        }),
      }),
    );

    await expect(
      module.create({
        appId: 'app-one',
        name: 'invalid',
        metadata: {
          targetPolicy: { allowedTargetKinds: ['admin_escape'] },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message:
        'external ingress targetPolicy.allowedTargetKinds contains unsupported target kind: admin_escape',
    });
  });

  it('rejects invalid metadata updates before writing durable state', async () => {
    const { module, control } = makeModule();

    await expect(
      module.update({
        appId: 'app-one',
        ingressId: 'ingress-1',
        patch: {
          metadata: {
            templates: {
              'template-1': {
                name: 'Missing session',
                prompt: 'Run {{task}}',
                allowedVariables: ['task'],
              },
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'external ingress template template-1.sessionId is invalid',
    });
    expect(control.updateExternalIngress).not.toHaveBeenCalled();
  });

  it('rejects disabled ingresses before nonce reservation', async () => {
    const { module, control, sessions } = makeModule({
      control: {
        getExternalIngressById: vi.fn(async () => ({
          ingressId: 'ingress-1',
          appId: 'app-one',
          name: 'main',
          secret: 'secret-1',
          enabled: false,
          metadata: {},
          createdAt: '2026-04-30T00:00:00.000Z',
          updatedAt: '2026-04-30T00:00:00.000Z',
        })),
      },
    });
    const rawBody = JSON.stringify({
      target: { kind: 'job_trigger', jobId: 'job-1' },
    });
    const request = signedInvokeInput({ secret: 'secret-1', rawBody });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Ingress is disabled',
    });
    expect(control.reserveExternalIngressNonce).not.toHaveBeenCalled();
    expect(sessions.ensureSession).not.toHaveBeenCalled();
  });

  it('rejects stale signatures before nonce reservation', async () => {
    const { module, control } = makeModule();
    const rawBody = JSON.stringify({
      target: { kind: 'job_trigger', jobId: 'job-1' },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      timestamp: String(Date.now() - 10 * 60_000),
    });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Invalid external ingress signature',
    });
    expect(control.reserveExternalIngressNonce).not.toHaveBeenCalled();
  });

  it('rejects invalid signatures before nonce reservation', async () => {
    const { module, control } = makeModule();
    const rawBody = JSON.stringify({
      target: { kind: 'job_trigger', jobId: 'job-1' },
    });
    const request = signedInvokeInput({ secret: 'secret-1', rawBody });

    await expect(
      module.invoke({ ...request, signature: 'bad-signature' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Invalid external ingress signature',
    });
    expect(control.reserveExternalIngressNonce).not.toHaveBeenCalled();
  });

  it('rejects nonce replays before invocation insert', async () => {
    const { module, control } = makeModule({
      control: {
        reserveExternalIngressNonce: vi.fn(async () => ({
          ok: false as const,
          code: 'NONCE_REPLAY',
        })),
      },
    });
    const rawBody = JSON.stringify({
      target: { kind: 'job_trigger', jobId: 'job-1' },
    });
    const request = signedInvokeInput({ secret: 'secret-1', rawBody });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'External ingress nonce replay',
    });
    expect(control.createExternalIngressInvocation).not.toHaveBeenCalled();
  });

  it('rejects duplicate active invocations for the same idempotency key', async () => {
    const { module, control } = makeModule({
      control: {
        getExternalIngressInvocationByIdempotencyKey: vi.fn(async () => ({
          invocationId: 'invocation-existing',
          status: 'pending',
          bodyHash: signatureCrypto.sha256(
            JSON.stringify({
              target: { kind: 'job_trigger', jobId: 'job-1' },
              idempotencyKey: 'idem-active',
            }),
          ),
          response: null,
          error: null,
          updatedAt: '2026-04-30T00:00:00.000Z',
        })),
      },
    });
    const rawBody = JSON.stringify({
      target: { kind: 'job_trigger', jobId: 'job-1' },
      idempotencyKey: 'idem-active',
    });
    const request = signedInvokeInput({ secret: 'secret-1', rawBody });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Duplicate active external ingress invocation',
    });
    expect(control.reserveExternalIngressNonce).not.toHaveBeenCalled();
    expect(control.createExternalIngressInvocation).not.toHaveBeenCalled();
    expect(control.updateExternalIngressInvocation).not.toHaveBeenCalled();
  });

  it('rejects requests whose payload appId does not match ingress app scope', async () => {
    const { module, control, sessions } = makeModule();
    const rawBody = JSON.stringify({
      appId: 'app-two',
      target: {
        kind: 'session_message',
        conversationId: 'conv-1',
        message: 'hello',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
    });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Request appId does not match ingress app scope',
    });
    expect(control.reserveExternalIngressNonce).not.toHaveBeenCalled();
    expect(sessions.ensureSession).not.toHaveBeenCalled();
  });

  it('reuses completed invocations for idempotent retries', async () => {
    const { module, control, sessions, jobs } = makeModule({
      control: {
        getExternalIngressInvocationByIdempotencyKey: vi.fn(async () => ({
          invocationId: 'invocation-existing',
          status: 'completed',
          bodyHash: signatureCrypto.sha256(
            JSON.stringify({
              target: {
                kind: 'job_trigger',
                jobId: 'job-1',
              },
            }),
          ),
          response: {
            targetKind: 'job_trigger',
            jobId: 'job-1',
            triggerId: 'trigger-1',
          },
          error: null,
          updatedAt: '2026-04-30T00:00:00.000Z',
        })),
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'job_trigger',
        jobId: 'job-1',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-2',
    });

    await expect(module.invoke(request)).resolves.toEqual({
      invocationId: 'invocation-existing',
      duplicate: true,
      status: 'completed',
      targetKind: 'job_trigger',
      jobId: 'job-1',
      triggerId: 'trigger-1',
    });
    expect(control.reserveExternalIngressNonce).not.toHaveBeenCalled();
    expect(control.createExternalIngressInvocation).not.toHaveBeenCalled();
    expect(sessions.ensureSession).not.toHaveBeenCalled();
    expect(jobs.triggerJob).not.toHaveBeenCalled();
    expect(control.updateExternalIngressInvocation).not.toHaveBeenCalled();
  });

  it('rejects idempotency key reuse with a different body hash', async () => {
    const { module, control, jobs } = makeModule({
      control: {
        getExternalIngressInvocationByIdempotencyKey: vi.fn(async () => ({
          invocationId: 'invocation-existing',
          status: 'completed',
          bodyHash: 'different-body-hash',
          response: { targetKind: 'job_trigger' },
          error: null,
          updatedAt: '2026-04-30T00:00:00.000Z',
        })),
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'job_trigger',
        jobId: 'job-1',
      },
      idempotencyKey: 'idem-reused',
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-reused',
    });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Idempotency key reused with different request body',
    });
    expect(control.reserveExternalIngressNonce).not.toHaveBeenCalled();
    expect(jobs.triggerJob).not.toHaveBeenCalled();
  });

  it('ensures a session then accepts message for session_message targets', async () => {
    const { module, control, sessions, registerSessionGroup } = makeModule();
    const rawBody = JSON.stringify({
      target: {
        kind: 'session_message',
        conversationId: 'conv-1',
        message: 'launch now',
        threadId: 'thread-1',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-3',
    });

    const result = await module.invoke(request);
    expect(result).toMatchObject({
      invocationId: 'invocation-new',
      duplicate: false,
      targetKind: 'session_message',
      sessionId: 'session-1',
      messageId: 'message-1',
      acceptedEventId: 101,
      wait: {
        kind: 'session',
        sessionId: 'session-1',
        afterEventId: 101,
      },
      enqueue: {
        conversationJid: 'app:app-one:conv-1',
        threadId: null,
        queueKey: 'app:app-one:conv-1',
      },
      registerGroup: {
        conversationJid: 'app:app-one:conv-1',
        group: expect.objectContaining({
          folder: 'app_conv_1',
        }),
      },
    });
    expect(
      (result as Record<PropertyKey, unknown>)[
        EXTERNAL_INGRESS_RUNTIME_DISPATCH
      ],
    ).toMatchObject({
      localEnqueue: false,
      enqueue: {
        queueKey: 'app:app-one:conv-1',
        durableAdmissionCreated: true,
      },
    });
    expect(registerSessionGroup).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'app:app-one:conv-1' }),
    );
    expect(sessions.ensureSession).toHaveBeenCalledWith({
      appId: 'app-one',
      conversationId: 'conv-1',
      title: null,
    });
    expect(sessions.acceptMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'launch now',
        threadId: 'thread-1',
        beforeDurableAdmission: expect.any(Function),
      }),
    );
    expect(control.updateExternalIngressInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'invocation-new',
        status: 'completed',
      }),
    );
    expect(control.createExternalIngressInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyHash: expect.any(String),
        requestBody: expect.stringMatching(/^sha256:/),
        signature: 'redacted',
        expiresAt: '2026-05-07T00:00:00.000Z',
      }),
    );
    expect(
      control.createExternalIngressInvocation.mock.calls[0]![0].requestBody,
    ).not.toContain('launch now');
  });

  it('accepts conversation_message targets without storing runtime routing in the public response', async () => {
    const { module, conversationMessages, control } = makeModule({
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['conversation_message'],
          conversationIds: ['conversation:tg:-100'],
          allowedAgentIds: ['agent:main_agent'],
        },
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'conversation_message',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:42',
        agentId: 'agent:main_agent',
        message: 'hello from external system',
        senderId: 'crm-worker',
        senderName: 'CRM Worker',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-conversation-message',
    });

    const result = await module.invoke(request);

    expect(result).toMatchObject({
      invocationId: 'invocation-new',
      duplicate: false,
      targetKind: 'conversation_message',
      conversationId: 'conversation:tg:-100',
      threadId: 'thread:tg:-100:42',
      messageId: 'conversation-message-1',
      acceptedEventId: 202,
    });
    expect(result).not.toHaveProperty('enqueue');
    expect(JSON.stringify(result)).not.toContain('queueKey');
    expect(
      (result as Record<PropertyKey, unknown>)[
        EXTERNAL_INGRESS_RUNTIME_DISPATCH
      ],
    ).toMatchObject({
      localEnqueue: false,
      enqueue: {
        queueKey: 'tg:-100::thread:42',
        durableAdmissionCreated: true,
      },
    });
    expect(conversationMessages.acceptMessage).toHaveBeenCalledWith({
      appId: 'app-one',
      invocationId: 'invocation-new',
      conversationId: 'conversation:tg:-100',
      threadId: 'thread:tg:-100:42',
      agentId: 'agent:main_agent',
      message: 'hello from external system',
      senderId: 'crm-worker',
      senderName: 'CRM Worker',
      correlationId: null,
    });
    expect(control.updateExternalIngressInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.not.objectContaining({
          enqueue: expect.anything(),
        }),
      }),
    );
  });

  it('rejects conversation_message targets that omit agentId when agent policy is scoped', async () => {
    const { module, conversationMessages } = makeModule({
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['conversation_message'],
          conversationIds: ['conversation:tg:-100'],
          allowedAgentIds: ['agent:main_agent'],
        },
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'conversation_message',
        conversationId: 'conversation:tg:-100',
        message: 'launch now',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-conversation-agent-policy-missing',
    });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'Ingress is not allowed to invoke this conversation agent target',
    });
    expect(conversationMessages.acceptMessage).not.toHaveBeenCalled();
  });

  it('rejects explicit conversation_message agent targets not allowed by the ingress policy', async () => {
    const { module, conversationMessages } = makeModule({
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['conversation_message'],
          conversationIds: ['conversation:tg:-100'],
        },
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'conversation_message',
        conversationId: 'conversation:tg:-100',
        agentId: 'agent:main_agent',
        message: 'launch now',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-conversation-agent-policy-deny',
    });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'Ingress is not allowed to invoke this conversation agent target',
    });
    expect(conversationMessages.acceptMessage).not.toHaveBeenCalled();
  });

  it('mirrors conversation_message input into the provider conversation before queueing', async () => {
    const { module, conversationProviderMessages } = makeModule({
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['conversation_message'],
          conversationIds: ['conversation:tg:-100'],
        },
      },
      conversationProviderMessages: {},
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'conversation_message',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:42',
        message: 'trigger the job',
        senderName: 'QA Worker',
      },
    });

    const result = await module.invoke(
      signedInvokeInput({
        secret: 'secret-1',
        rawBody,
        nonce: 'nonce-conversation-provider-projection',
      }),
    );

    expect(conversationProviderMessages?.send).toHaveBeenCalledWith({
      conversationJid: 'tg:-100',
      threadId: '42',
      providerAccountId: 'channel-providerAccount:app-one:telegram',
      text: 'QA Worker: trigger the job',
    });
    expect(
      (result as Record<PropertyKey, unknown>)[
        EXTERNAL_INGRESS_RUNTIME_DISPATCH
      ],
    ).toMatchObject({
      localEnqueue: false,
      enqueue: {
        queueKey: 'tg:-100::thread:42',
        durableAdmissionCreated: true,
      },
    });
  });

  it('rejects conversation_message targets not allowed by the ingress policy', async () => {
    const { module, conversationMessages } = makeModule({
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['conversation_message'],
          conversationIds: ['conversation:tg:-100'],
        },
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'conversation_message',
        conversationId: 'conversation:tg:-200',
        message: 'launch now',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-conversation-policy-deny',
    });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Ingress is not allowed to invoke this conversation target',
    });
    expect(conversationMessages.acceptMessage).not.toHaveBeenCalled();
  });

  it('rejects session_message targets not allowed by the ingress policy', async () => {
    const { module, sessions } = makeModule({
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['session_message'],
          conversationIds: ['allowed-conversation'],
        },
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'session_message',
        conversationId: 'conv-1',
        message: 'launch now',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-policy-deny',
    });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Ingress is not allowed to invoke this session target',
    });
    expect(sessions.ensureSession).not.toHaveBeenCalled();
  });

  it('requires allowed sessionId when a sessionId is explicitly supplied', async () => {
    const { module, sessions } = makeModule({
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['session_message'],
          conversationIds: ['conv-1'],
          sessionIds: ['session-allowed'],
        },
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'session_message',
        sessionId: 'session-off-policy',
        conversationId: 'conv-1',
        message: 'launch now',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-session-policy',
    });

    await expect(module.invoke(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Ingress is not allowed to invoke this session target',
    });
    expect(sessions.acceptMessage).not.toHaveBeenCalled();
  });

  it('marks invocations failed when dispatch throws', async () => {
    const dispatchError = new Error('dispatch failed');
    const { module, control } = makeModule({
      sessions: {
        acceptMessage: vi.fn(async () => {
          throw dispatchError;
        }),
      },
    });
    const rawBody = JSON.stringify({
      target: {
        kind: 'session_message',
        sessionId: 'session-1',
        message: 'launch now',
      },
    });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      nonce: 'nonce-dispatch-fail',
    });

    await expect(module.invoke(request)).rejects.toThrow('dispatch failed');
    expect(control.updateExternalIngressInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'invocation-new',
        status: 'failed',
        error: 'dispatch failed',
      }),
    );
  });

  it('uses ingressId when reading signed wait invocations', async () => {
    const { module, control } = makeModule();
    const rawBody = JSON.stringify({ invocationId: 'invocation-1' });
    const request = signedInvokeInput({
      secret: 'secret-1',
      rawBody,
      path: '/v1/ingresses/ingress-1/wait',
      nonce: 'nonce-wait',
    });

    await expect(module.signedWait(request)).resolves.toMatchObject({
      invocationId: 'invocation-1',
      status: 'completed',
    });
    expect(control.getExternalIngressInvocation).toHaveBeenCalledWith(
      'invocation-1',
      'app-one',
      'ingress-1',
    );
  });
});

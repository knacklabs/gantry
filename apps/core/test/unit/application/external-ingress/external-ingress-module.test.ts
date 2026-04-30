import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ExternalIngressModule } from '@core/application/external-ingress/external-ingress-module.js';
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
  jobs?: Partial<ExternalIngressJobs>;
  metadata?: unknown;
}) {
  const control: ExternalIngressControl = {
    createExternalIngress: vi.fn(),
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
        chatJid: 'app:app-one:conv-1',
        group: {
          name: 'app-one:conv-1',
          folder: 'app_conv_1',
          trigger: '',
          added_at: '2026-04-30T00:00:00.000Z',
          requiresTrigger: false,
          isMain: false,
        },
      },
    })),
    acceptMessage: vi.fn(async () => ({
      accepted: true,
      messageId: 'message-1',
      acceptedEventId: 101,
      enqueue: {
        chatJid: 'app:app-one:conv-1',
        threadId: null,
        queueKey: 'app:app-one:conv-1',
      },
    })),
    ...overrides?.sessions,
  };

  const jobs: ExternalIngressJobs = {
    triggerJob: vi.fn(async () => ({ triggerId: 'trigger-1' })),
    createJob: vi.fn(),
    ...overrides?.jobs,
  };

  const module = new ExternalIngressModule({
    control: control as never,
    sessions: sessions as never,
    jobs: jobs as never,
    now: () => '2026-04-30T00:00:00.000Z',
    createSecret: () => 'secret-generated',
    createInvocationId: () => 'invocation-new',
    signatureCrypto,
    perAppTriggerLimit: 5,
    perJobTriggerLimit: 2,
  });

  return { module, control, sessions, jobs };
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

type ExternalIngressJobs = {
  triggerJob: ReturnType<typeof vi.fn>;
  createJob: ReturnType<typeof vi.fn>;
};

describe('ExternalIngressModule', () => {
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
    const { module, control, sessions } = makeModule();
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

    await expect(module.invoke(request)).resolves.toMatchObject({
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
        chatJid: 'app:app-one:conv-1',
        threadId: null,
        queueKey: 'app:app-one:conv-1',
      },
      registerGroup: {
        chatJid: 'app:app-one:conv-1',
        group: expect.objectContaining({
          folder: 'app_conv_1',
        }),
      },
    });
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
      }),
    );
    expect(control.updateExternalIngressInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'invocation-new',
        status: 'completed',
      }),
    );
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

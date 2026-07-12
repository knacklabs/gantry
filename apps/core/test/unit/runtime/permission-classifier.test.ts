import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryLlmClient } from '@core/domain/ports/memory-llm-client.js';

const query = vi.hoisted(() => vi.fn());
const isConfigured = vi.hoisted(() => vi.fn());
const getMemoryLlmClient = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@core/memory/memory-llm-port.js', () => ({
  getMemoryLlmClient,
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: { warn },
}));

import {
  consultPermissionClassifier,
  consultPermissionClassifierBeforePrompt,
  PERMISSION_CLASSIFIER_TIMEOUT_MS,
  PERMISSION_CLASSIFIER_MAX_TOOL_INPUT_CHARS,
  publishPermissionClassifierDecision,
  redactPermissionClassifierToolInput,
  recordHumanPermissionPromotionSignal,
} from '@core/runtime/permission-classifier.js';

const baseInput = {
  appId: 'default' as never,
  agentIdentity: { id: 'agent-1', name: 'Researcher', folder: 'researcher' },
  turnIntentSummary: 'Inspect the repository state requested by the user.',
  canonicalToolName: 'mcp__github__search',
  toolInput: { query: 'open pull requests' },
  policyDecisionReason: 'No durable rule matched this tool call.',
  memoryModelConfig: {
    extractor: 'extractor-model',
    modelProfiles: {
      extractor: {
        alias: 'extractor',
        runnerModel: 'extractor-model',
        responseFamily: 'test-family',
        modelRoute: 'test-route',
        modelRouteLabel: 'Test route',
        displayName: 'Extractor',
      },
    },
  },
};

describe('permission classifier verdict client', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    isConfigured.mockReturnValue(true);
    query.mockResolvedValue(
      '{"decision":"allow","reason":"Read-only lookup."}',
    );
    getMemoryLlmClient.mockReturnValue({
      isConfigured,
      query,
    } satisfies MemoryLlmClient);
  });

  it('accepts a strict allow verdict and uses the extractor model by default', async () => {
    const result = await consultPermissionClassifier(baseInput);

    expect(result).toMatchObject({
      decision: 'allow',
      reason: 'Read-only lookup.',
    });
    expect(result.failureCode).toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'extractor-model',
        modelProfile: baseInput.memoryModelConfig.modelProfiles.extractor,
        systemPrompt: expect.stringContaining('Return allow only when'),
        timeoutMs: 12_000,
      }),
    );
    expect(JSON.parse(query.mock.calls[0]?.[0].prompt as string)).toMatchObject(
      {
        agentIdentity: baseInput.agentIdentity,
        turnIntentSummary: baseInput.turnIntentSummary,
        canonicalToolName: baseInput.canonicalToolName,
        policyDecisionReason: baseInput.policyDecisionReason,
      },
    );
  });

  it('uses the auto-mode model override ahead of the extractor slot', async () => {
    await consultPermissionClassifier({
      ...baseInput,
      autoModeModel: 'sonnet',
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.not.stringMatching(/^sonnet$/),
        modelProfile: expect.objectContaining({ alias: 'sonnet' }),
      }),
    );
  });

  it('fails closed when the auto-mode model cannot be resolved', async () => {
    await expectFailure('model_resolution_failure', {
      ...baseInput,
      autoModeModel: 'not-a-model-alias',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts an ask verdict wrapped in a code fence', async () => {
    query.mockResolvedValue(
      '```json\n{"decision":"ask","reason":"Scope is ambiguous."}\n```',
    );

    await expect(consultPermissionClassifier(baseInput)).resolves.toMatchObject(
      {
        decision: 'ask',
        reason: 'Scope is ambiguous.',
      },
    );
  });

  it('sends the required intent and policy context with sensitive input redacted', async () => {
    await consultPermissionClassifier({
      ...baseInput,
      toolInput: {
        query: 'open pull requests',
        authorization: 'Bearer private-value',
      },
    });

    const request = query.mock.calls[0]?.[0];
    expect(request.systemPrompt).toContain('Return allow only');
    expect(request.prompt).toContain(baseInput.agentIdentity.id);
    expect(request.prompt).toContain(baseInput.turnIntentSummary);
    expect(request.prompt).toContain(baseInput.canonicalToolName);
    expect(request.prompt).toContain(baseInput.policyDecisionReason);
    expect(request.prompt).toContain('[REDACTED]');
    expect(request.prompt).not.toContain('private-value');
  });

  it('adds recent exact-shape denial context to the classifier payload', async () => {
    await consultPermissionClassifier({
      ...baseInput,
      recentlyDeniedExactToolShape: true,
    });

    expect(query.mock.calls[0]?.[0].prompt).toContain(
      'the operator recently denied this exact tool shape',
    );
  });

  it('deep-redacts sensitive keys and truncates long tool input', async () => {
    const redacted = redactPermissionClassifierToolInput({
      nested: {
        apiToken: 'token-value',
        apiKey: 'api-key-value',
        api_key: 'api-underscore-key-value',
        credential: 'credential-value',
        credentials: 'credentials-value',
        key: 'key-value',
        passphrase: 'passphrase-value',
        bearer: 'bearer-value',
        cookie: 'cookie-value',
        session: 'session-value',
        PASSWORD: 'password-value',
        authorizationHeader: 'Bearer secret',
      },
      text: 'x'.repeat(PERMISSION_CLASSIFIER_MAX_TOOL_INPUT_CHARS * 2),
    });

    expect(redacted).not.toContain('token-value');
    expect(redacted).not.toContain('api-key-value');
    expect(redacted).not.toContain('api-underscore-key-value');
    expect(redacted).not.toContain('credential-value');
    expect(redacted).not.toContain('credentials-value');
    expect(redacted).not.toContain('key-value');
    expect(redacted).not.toContain('passphrase-value');
    expect(redacted).not.toContain('bearer-value');
    expect(redacted).not.toContain('cookie-value');
    expect(redacted).not.toContain('session-value');
    expect(redacted).not.toContain('password-value');
    expect(redacted).not.toContain('Bearer secret');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted.length).toBeLessThanOrEqual(
      PERMISSION_CLASSIFIER_MAX_TOOL_INPUT_CHARS,
    );
    expect(redacted).toContain('[TRUNCATED]');

    await consultPermissionClassifier({
      ...baseInput,
      toolInput: {
        accessToken: 'must-not-reach-prompt',
        body: 'x'.repeat(8_000),
      },
    });
    const prompt = query.mock.calls[0]?.[0].prompt as string;
    expect(prompt).not.toContain('must-not-reach-prompt');
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).toContain('[TRUNCATED]');
  });

  it('fails closed when the LLM port is unconfigured', async () => {
    isConfigured.mockReturnValue(false);

    await expectFailure('llm_unconfigured');
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when acquiring the LLM client throws', async () => {
    getMemoryLlmClient.mockImplementation(() => {
      throw new Error('client unavailable');
    });

    await expectFailure('llm_unconfigured');
  });

  it('fails closed on timeout', async () => {
    vi.useFakeTimers();
    query.mockImplementation(() => new Promise(() => undefined));

    const pending = consultPermissionClassifier(baseInput);
    await vi.advanceTimersByTimeAsync(PERMISSION_CLASSIFIER_TIMEOUT_MS + 1);

    await expect(pending).resolves.toMatchObject({
      decision: 'ask',
      failureCode: 'timeout',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: 'timeout',
        reasonCode: 'timeout',
      }),
      expect.any(String),
    );
  });

  it('fails closed when the caller aborts', async () => {
    const controller = new AbortController();
    query.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const pending = consultPermissionClassifier({
      ...baseInput,
      signal: controller.signal,
    });
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).resolves.toMatchObject({
      decision: 'ask',
      failureCode: 'aborted',
    });
  });

  it('fails closed when the query throws', async () => {
    query.mockRejectedValue(new Error('gateway failed'));
    await expectFailure('query_error');
  });

  it('fails closed on malformed JSON', async () => {
    query.mockResolvedValue('not json');
    await expectFailure('parse_failure');
  });

  it.each([
    '{}',
    '{"decision":"deny","reason":"No."}',
    '{"decision":"allow","reason":""}',
    '{"decision":"allow","reason":"Okay","extra":true}',
  ])('fails closed on invalid verdict %s', async (response) => {
    query.mockResolvedValue(response);
    await expectFailure('validation_failure');
  });
});

describe('permission classifier decision events', () => {
  it('records human cancellation as contrary evidence without blocking', async () => {
    const markDenied = vi.fn(async () => undefined);
    recordHumanPermissionPromotionSignal({
      repository: {
        incrementAndGet: vi.fn(),
        get: vi.fn(),
        markOffered: vi.fn(),
        markDenied,
      },
      appId: 'app:test',
      agentFolder: 'researcher',
      request: {
        requestId: 'request:cancel',
        sourceAgentFolder: 'researcher',
        toolName: 'RunCommand',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'RunCommand', ruleContent: 'git status' }],
          },
        ],
      },
      decision: {
        approved: false,
        mode: 'cancel',
        decidedBy: 'operator',
        decisionClassification: 'user_reject',
      },
    });

    await vi.waitFor(() => expect(markDenied).toHaveBeenCalledOnce());
    expect(markDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestionKey: 'researcher|RunCommand(git status)',
      }),
    );
  });

  it('skips untrusted requesters without consulting or publishing an event', async () => {
    const classifierConsult = vi.fn();
    const publishRuntimeEvent = vi.fn();

    await expect(
      consultPermissionClassifierBeforePrompt({
        permissionMode: 'auto',
        requestFamily: 'tool',
        agentFolder: 'researcher',
        correlationId: 'request:untrusted',
        actor: 'permission',
        turnIntentSummary: 'Inspect the repository status.',
        canonicalToolName: 'RunCommand',
        toolInput: { command: 'git status' },
        policyDecisionReason: 'No durable rule matched.',
        classifierConfig: { memoryExtractorModel: 'extractor-model' },
        publishRuntimeEvent,
        classifierConsult,
      }),
    ).resolves.toBeUndefined();
    expect(classifierConsult).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
  });

  it('passes recent repository denial context into a trusted consultation', async () => {
    const classifierConsult = vi.fn(async () => ({
      decision: 'ask' as const,
      reason: 'Recent contrary evidence.',
      latencyMs: 1,
    }));
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await consultPermissionClassifierBeforePrompt({
      permissionMode: 'auto',
      trustedRequester: true,
      requestFamily: 'tool',
      appId: 'app:test',
      agentFolder: 'researcher',
      correlationId: 'request:denied',
      actor: 'permission',
      turnIntentSummary: 'Inspect the repository status.',
      canonicalToolName: 'RunCommand',
      toolInput: { command: 'git status' },
      policyDecisionReason: 'No durable rule matched.',
      classifierConfig: { memoryExtractorModel: 'extractor-model' },
      publishRuntimeEvent,
      classifierConsult,
      promotion: {
        repository: {
          incrementAndGet: vi.fn(),
          get: vi.fn(async () => ({
            appId: 'app:test',
            agentFolder: 'researcher',
            suggestionKey: 'researcher|RunCommand(git status)',
            allowCount: 0,
            lastOfferedAt: null,
            deniedAt: new Date().toISOString(),
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:00.000Z',
          })),
          markOffered: vi.fn(),
          markDenied: vi.fn(),
        },
        offer: vi.fn(),
      },
    });

    expect(classifierConsult).toHaveBeenCalledWith(
      expect.objectContaining({ recentlyDeniedExactToolShape: true }),
    );
  });

  it('counts keyed auto-allows and emits the promotion prompt without blocking', async () => {
    const offer = vi.fn(async () => undefined);
    const incrementAndGet = vi.fn(async () => ({
      appId: 'app:test',
      agentFolder: 'researcher',
      suggestionKey: 'researcher|RunCommand(git status)',
      allowCount: 3,
      lastOfferedAt: null,
      deniedAt: null,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    }));
    const markOffered = vi.fn(async () => true);
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await expect(
      consultPermissionClassifierBeforePrompt({
        permissionMode: 'auto',
        trustedRequester: true,
        requestFamily: 'tool',
        appId: 'app:test',
        agentId: 'agent:test',
        agentFolder: 'researcher',
        runId: 'run:test',
        conversationId: 'conversation:test',
        correlationId: 'request:test',
        actor: 'permission',
        turnIntentSummary: 'Inspect the repository status.',
        canonicalToolName: 'RunCommand',
        toolInput: { command: 'git status' },
        policyDecisionReason: 'No durable rule matched.',
        classifierConfig: { memoryExtractorModel: 'extractor-model' },
        publishRuntimeEvent,
        classifierConsult: async () => ({
          decision: 'allow',
          reason: 'Read-only lookup.',
          latencyMs: 10,
        }),
        promotion: {
          repository: {
            incrementAndGet,
            get: vi.fn(async () => null),
            markOffered,
            markDenied: vi.fn(async () => undefined),
          },
          offer,
        },
      }),
    ).resolves.toMatchObject({
      decision: 'allow',
      suggestionKey: 'researcher|RunCommand(git status)',
    });

    await vi.waitFor(() => expect(offer).toHaveBeenCalledTimes(1));
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          suggestionKey: 'researcher|RunCommand(git status)',
        }),
      }),
    );
    expect(offer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestFamily: 'promotion',
        decisionOptions: ['allow_persistent_rule', 'cancel'],
      }),
    );
  });

  it('publishes an allow verdict with the exact runtime envelope and payload', async () => {
    const publishRuntimeEvent = vi.fn().mockResolvedValue(undefined);

    await publishPermissionClassifierDecision({
      publishRuntimeEvent,
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      runId: 'run:test' as never,
      actor: 'permission-classifier',
      toolName: 'mcp__source__lookup',
      decision: 'allow',
      reason: 'Read-only lookup matches the turn intent.',
      latencyMs: 24,
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
      runId: 'run:test',
      eventType: 'permission.classifier_decision',
      actor: 'permission-classifier',
      payload: {
        toolName: 'mcp__source__lookup',
        decision: 'allow',
        reason: 'Read-only lookup matches the turn intent.',
        latencyMs: 24,
      },
    });
  });

  it('publishes failure and suggestion details without duplicating envelope ids', async () => {
    const publishRuntimeEvent = vi.fn().mockResolvedValue(undefined);

    await publishPermissionClassifierDecision({
      publishRuntimeEvent,
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      runId: 'run:test' as never,
      jobId: 'job:test' as never,
      conversationId: 'conversation:test' as never,
      threadId: 'thread:test' as never,
      correlationId: 'request:test',
      actor: 'permission-classifier',
      toolName: 'RunCommand',
      decision: 'ask',
      reason: 'Classifier unavailable; ask the user.',
      latencyMs: 3_000,
      failureCode: 'timeout',
      suggestionKey: 'RunCommand(git status)',
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
      runId: 'run:test',
      jobId: 'job:test',
      conversationId: 'conversation:test',
      threadId: 'thread:test',
      correlationId: 'request:test',
      eventType: 'permission.classifier_decision',
      actor: 'permission-classifier',
      payload: {
        toolName: 'RunCommand',
        decision: 'ask',
        reason: 'Classifier unavailable; ask the user.',
        latencyMs: 3_000,
        failureCode: 'timeout',
        suggestionKey: 'RunCommand(git status)',
      },
    });
    expect(publishRuntimeEvent.mock.calls[0]?.[0].payload).not.toHaveProperty(
      'runId',
    );
    expect(publishRuntimeEvent.mock.calls[0]?.[0].payload).not.toHaveProperty(
      'agentId',
    );
    expect(publishRuntimeEvent.mock.calls[0]?.[0].payload).not.toHaveProperty(
      'jobId',
    );
  });
});

async function expectFailure(
  failureCode: string,
  input: Parameters<typeof consultPermissionClassifier>[0] = baseInput,
): Promise<void> {
  await expect(consultPermissionClassifier(input)).resolves.toMatchObject({
    decision: 'ask',
    failureCode,
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ failureCode, reasonCode: failureCode }),
    expect.any(String),
  );
}

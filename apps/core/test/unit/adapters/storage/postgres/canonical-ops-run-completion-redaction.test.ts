import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAgentRun, saveAgentRun, getAgentSession, getConfigVersion } =
  vi.hoisted(() => ({
    getAgentRun: vi.fn(),
    saveAgentRun: vi.fn(),
    getAgentSession: vi.fn(),
    getConfigVersion: vi.fn(),
  }));

vi.mock(
  '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js',
  () => ({
    createPostgresDomainRepositories: vi.fn(() => ({
      agentRuns: {
        getAgentRun,
        saveAgentRun,
      },
      agentSessions: { getAgentSession },
      agentSessionDigests: {},
      agentConfigs: { getConfigVersion },
    })),
  }),
);

import { PostgresRuntimeRepositoryBundle } from '@core/adapters/storage/postgres/schema/canonical-ops-repo.postgres.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

describe('PostgresRuntimeRepositoryBundle run completion redaction', () => {
  beforeEach(() => {
    getAgentRun.mockReset();
    saveAgentRun.mockReset();
    getAgentSession.mockReset();
    getConfigVersion.mockReset();
  });

  it('redacts provider resume handles before storing and publishing completion summaries', async () => {
    const publish = vi.fn(async () => undefined);
    getAgentRun.mockResolvedValue({
      id: 'run-1',
      appId: 'app:test',
      sessionId: 'agent-session:test',
      status: 'running',
    } as never);

    const bundle = new PostgresRuntimeRepositoryBundle(
      { end: vi.fn(async () => undefined) } as never,
      {} as never,
      { runtimeEvents: { publish } },
    );

    await bundle.completeSessionAgentRun({
      runId: 'run-1',
      status: 'failed',
      resultSummary:
        '{"newSessionId":"json-new-handle"} sessionId=session-inline-handle',
      errorSummary:
        'boom provider-session:shape-secret claude-session-shape-secret',
    });

    expect(saveAgentRun).toHaveBeenCalledTimes(1);
    const savedRun = saveAgentRun.mock.calls[0][0];
    expect(savedRun.resultSummary).toContain('[REDACTED]');
    expect(savedRun.errorSummary).toContain('[REDACTED]');
    expect(savedRun.resultSummary).not.toContain('json-new-handle');
    expect(savedRun.resultSummary).not.toContain('session-inline-handle');
    expect(savedRun.errorSummary).not.toContain(
      'provider-session:shape-secret',
    );
    expect(savedRun.errorSummary).not.toContain('claude-session-shape-secret');

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0][0];
    expect(event.eventType).toBe(RUNTIME_EVENT_TYPES.RUN_FAILED);
    expect(event.payload.resultSummary).toContain('[REDACTED]');
    expect(event.payload.errorSummary).toContain('[REDACTED]');
    expect(event.payload.resultSummary).not.toContain('json-new-handle');
    expect(event.payload.resultSummary).not.toContain('session-inline-handle');
    expect(event.payload.errorSummary).not.toContain(
      'provider-session:shape-secret',
    );
    expect(event.payload.errorSummary).not.toContain(
      'claude-session-shape-secret',
    );
  });
});

describe('PostgresRuntimeRepositoryBundle createSessionAgentRun llmProfileId', () => {
  beforeEach(() => {
    saveAgentRun.mockReset();
    getAgentSession.mockReset();
    getConfigVersion.mockReset();
  });

  it("persists the agent's configured llmProfileId when a config version exists", async () => {
    getAgentSession.mockResolvedValue({
      id: 'agent-session:test',
      appId: 'app:test',
      agentId: 'agent:pulk',
      conversationId: 'sl:C1',
      threadId: null,
      jobId: undefined,
    } as never);
    getConfigVersion.mockResolvedValue({
      llmProfileId: 'llm:bedrock-kimi',
    } as never);

    const bundle = new PostgresRuntimeRepositoryBundle(
      { end: vi.fn(async () => undefined) } as never,
      {} as never,
      { runtimeEvents: { publish: vi.fn(async () => undefined) } },
    );

    await bundle.createSessionAgentRun({
      agentSessionId: 'agent-session:test',
      executionProviderId: 'deepagents:langchain',
      cause: 'message',
    });

    expect(saveAgentRun).toHaveBeenCalledTimes(1);
    const savedRun = saveAgentRun.mock.calls[0][0];
    expect(savedRun.llmProfileId).toBe('llm:bedrock-kimi');
  });

  it('falls back to the default llmProfileId when no config version is found', async () => {
    getAgentSession.mockResolvedValue({
      id: 'agent-session:test',
      appId: 'app:test',
      agentId: 'agent:pulk',
      conversationId: 'sl:C1',
      threadId: null,
      jobId: undefined,
    } as never);
    getConfigVersion.mockResolvedValue(null);

    const bundle = new PostgresRuntimeRepositoryBundle(
      { end: vi.fn(async () => undefined) } as never,
      {} as never,
      { runtimeEvents: { publish: vi.fn(async () => undefined) } },
    );

    await bundle.createSessionAgentRun({
      agentSessionId: 'agent-session:test',
      executionProviderId: 'deepagents:langchain',
      cause: 'message',
    });

    expect(saveAgentRun).toHaveBeenCalledTimes(1);
    const savedRun = saveAgentRun.mock.calls[0][0];
    expect(savedRun.llmProfileId).toBe('llm:default');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentSessionRepository } from '@core/domain/repositories/ops-repo.js';
import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import { createGroupAgentRunner } from '@core/runtime/group-agent-runner.js';
import { buildProviderSessionAccessFingerprint } from '@core/runtime/provider-session-access-fingerprint.js';
import {
  buildApprovedSkillContextBlock,
  createRuntimeResultSummaryAccumulator,
  completeSuccessfulRuntimeSessionRun,
  completeFailedRuntimeSessionRun,
  RUNTIME_RESULT_SUMMARY_MAX_CHARS,
  summarizeRuntimeResultForPersistence,
  truncateRuntimeResultSummary,
} from '@core/runtime/session-resume-runtime.js';

describe('session-resume-runtime', () => {
  it('runs maintenance-locked provider sessions without resume or head writes', async () => {
    const setSession = vi.fn();
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'default',
      agentId: 'agent:main_agent',
      agentSessionId: 'agent-session:main',
      latestProviderSessionLocked: true,
      lockedProviderSessionId: 'provider-session:locked',
    }));
    const runAgent = vi.fn(async (_group, input, _register, onOutput) => {
      await onOutput?.({
        status: 'success',
        result: 'ok',
        newSessionId: 'provider-session:ephemeral',
      });
      return {
        status: 'success',
        result: 'ok',
        newSessionId: 'provider-session:ephemeral',
      };
    });
    const defaultProviderId = ['anth', 'ropic:claude-agent-sdk'].join('');
    const runner = createGroupAgentRunner({
      deps: {
        channelRuntime: {
          hasChannel: () => true,
          supportsStreaming: () => false,
          supportsProgress: () => false,
          sendMessage: async () => {},
          sendStreamingChunk: async () => false,
          resetStreaming: () => {},
          setTyping: async () => {},
          sendProgressUpdate: async () => {},
        },
        queue: {
          enqueueMessageCheck: () => false,
          closeStdin: () => {},
          notifyIdle: () => {},
          registerProcess: () => {},
        },
        getGroup: () => undefined,
        clearSession: async () => {},
        getCursor: () => '',
        setCursor: () => {},
        saveState: async () => {},
        setGroupModelOverride: async () => {},
        setGroupThinkingOverride: async () => {},
        getAvailableGroups: () => [],
        getRegisteredJids: () => new Set(),
        runAgent: runAgent as never,
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: { id: defaultProviderId } as never,
        getSelectedAgentHarness: () => 'auto',
      },
      ops: () =>
        ({
          getAgentTurnContext,
          setSession,
        }) as unknown as RuntimeAgentSessionRepository,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
        },
        'hello',
        'tg:chat',
        'tg:chat',
      ),
    ).resolves.toBe('success');

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ promoteReadyProviderSession: true }),
    );
    expect(runAgent.mock.calls[0][1]).not.toHaveProperty('sessionId');
    expect(setSession).not.toHaveBeenCalled();
  });

  it('injects compacted-session transcript delta before resumed turn', async () => {
    const markProviderSessionDeltaReplay = vi.fn();
    const accessFingerprint = buildProviderSessionAccessFingerprint({});
    const getAgentTurnContext = vi.fn(async (input) =>
      input.promoteReadyProviderSession
        ? {
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
            providerSessionId: 'provider-session:ready',
            externalSessionId: 'provider-session:ready',
            providerSessionAccessFingerprint: accessFingerprint,
            compactionDeltaReplay: {
              status: 'pending',
              baseCursor: 'cursor:base',
              lockedAt: new Date().toISOString(),
            },
          }
        : {
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
            latestProviderSessionReady: true,
            readyProviderSessionId: 'provider-session:ready',
            readyExternalSessionId: 'provider-session:ready',
            providerSessionAccessFingerprint: accessFingerprint,
            compactionDeltaReplay: {
              status: 'pending',
              baseCursor: 'cursor:base',
              lockedAt: new Date().toISOString(),
            },
          },
    );
    const getContextMessagesSince = vi.fn(async () => [
      {
        id: '2',
        chat_jid: 'tg:chat',
        sender: 'user-1',
        content: 'overlap question',
        timestamp: '2026-04-28T00:00:02.000Z',
        is_from_me: false,
      },
      {
        id: '3',
        chat_jid: 'tg:chat',
        sender: 'bot',
        content: 'overlap answer',
        timestamp: '2026-04-28T00:00:03.000Z',
        is_from_me: true,
      },
    ]);
    const runAgent = vi.fn(async () => ({ status: 'success', result: 'ok' }));
    const defaultProviderId = ['anth', 'ropic:claude-agent-sdk'].join('');
    const runner = createGroupAgentRunner({
      deps: {
        channelRuntime: {
          hasChannel: () => true,
          supportsStreaming: () => false,
          supportsProgress: () => false,
          sendMessage: async () => {},
          sendStreamingChunk: async () => false,
          resetStreaming: () => {},
          setTyping: async () => {},
          sendProgressUpdate: async () => {},
        },
        queue: {
          enqueueMessageCheck: () => false,
          closeStdin: () => {},
          notifyIdle: () => {},
          registerProcess: () => {},
        },
        getGroup: () => undefined,
        clearSession: async () => {},
        getCursor: () => '',
        setCursor: () => {},
        saveState: async () => {},
        setGroupModelOverride: async () => {},
        setGroupThinkingOverride: async () => {},
        getAvailableGroups: () => [],
        getRegisteredJids: () => new Set(),
        runAgent: runAgent as never,
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: { id: defaultProviderId } as never,
        getSelectedAgentHarness: () => 'auto',
      },
      ops: () =>
        ({
          getAgentTurnContext,
          getContextMessagesSince,
          markProviderSessionDeltaReplay,
        }) as never,
    });

    await runner(
      {
        name: 'Main',
        folder: 'main_agent',
        added_at: new Date(0).toISOString(),
      },
      'hello',
      'tg:chat',
      'tg:chat',
    );

    expect(getContextMessagesSince).toHaveBeenCalledWith(
      'tg:chat',
      'cursor:base',
      51,
      { threadId: null, providerAccountId: undefined },
    );
    expect(runAgent.mock.calls[0][1].sessionId).toBe('provider-session:ready');
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      '<gantry_compaction_delta>',
    );
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      'overlap question',
    );
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      'overlap answer',
    );
    expect(markProviderSessionDeltaReplay).toHaveBeenCalledWith({
      providerSessionId: 'provider-session:ready',
      agentSessionId: 'agent-session:main',
      provider: defaultProviderId,
      externalSessionId: 'provider-session:ready',
      status: 'applied',
      compactionBaseCursor: 'cursor:base',
    });
  });

  it('keeps compacted-session delta replay pending when the first resumed turn fails', async () => {
    const markProviderSessionDeltaReplay = vi.fn();
    const accessFingerprint = buildProviderSessionAccessFingerprint({});
    const getAgentTurnContext = vi.fn(async (input) =>
      input.promoteReadyProviderSession
        ? {
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
            providerSessionId: 'provider-session:ready',
            externalSessionId: 'provider-session:ready',
            providerSessionAccessFingerprint: accessFingerprint,
            compactionDeltaReplay: {
              status: 'pending',
              baseCursor: 'cursor:base',
              lockedAt: new Date().toISOString(),
            },
          }
        : {
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
            latestProviderSessionReady: true,
            readyProviderSessionId: 'provider-session:ready',
            readyExternalSessionId: 'provider-session:ready',
            providerSessionAccessFingerprint: accessFingerprint,
            compactionDeltaReplay: {
              status: 'pending',
              baseCursor: 'cursor:base',
              lockedAt: new Date().toISOString(),
            },
          },
    );
    const getContextMessagesSince = vi.fn(async () => [
      {
        id: '2',
        chat_jid: 'tg:chat',
        sender: 'user-1',
        content: 'overlap question',
        timestamp: '2026-04-28T00:00:02.000Z',
        is_from_me: false,
      },
    ]);
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce({ status: 'error', result: null, error: 'boom' })
      .mockResolvedValueOnce({ status: 'success', result: 'ok' });
    const defaultProviderId = ['anth', 'ropic:claude-agent-sdk'].join('');
    const runner = createGroupAgentRunner({
      deps: {
        channelRuntime: {
          hasChannel: () => true,
          supportsStreaming: () => false,
          supportsProgress: () => false,
          sendMessage: async () => {},
          sendStreamingChunk: async () => false,
          resetStreaming: () => {},
          setTyping: async () => {},
          sendProgressUpdate: async () => {},
        },
        queue: {
          enqueueMessageCheck: () => false,
          closeStdin: () => {},
          notifyIdle: () => {},
          registerProcess: () => {},
        },
        getGroup: () => undefined,
        clearSession: async () => {},
        getCursor: () => '',
        setCursor: () => {},
        saveState: async () => {},
        setGroupModelOverride: async () => {},
        setGroupThinkingOverride: async () => {},
        getAvailableGroups: () => [],
        getRegisteredJids: () => new Set(),
        runAgent: runAgent as never,
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: { id: defaultProviderId } as never,
        getSelectedAgentHarness: () => 'auto',
      },
      ops: () =>
        ({
          getAgentTurnContext,
          getContextMessagesSince,
          markProviderSessionDeltaReplay,
        }) as never,
    });

    const group = {
      name: 'Main',
      folder: 'main_agent',
      added_at: new Date(0).toISOString(),
    };

    await expect(runner(group, 'hello', 'tg:chat', 'tg:chat')).resolves.toBe(
      'error',
    );
    expect(runAgent.mock.calls[0][1].sessionId).toBe('provider-session:ready');
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      '<gantry_compaction_delta>',
    );
    expect(markProviderSessionDeltaReplay).not.toHaveBeenCalled();
    expect(
      getAgentTurnContext.mock.calls.some(
        ([input]) => input.promoteReadyProviderSession === true,
      ),
    ).toBe(false);

    await expect(
      runner(group, 'hello again', 'tg:chat', 'tg:chat'),
    ).resolves.toBe('success');
    expect(runAgent.mock.calls[1][1].sessionId).toBe('provider-session:ready');
    expect(markProviderSessionDeltaReplay).toHaveBeenCalledWith({
      providerSessionId: 'provider-session:ready',
      agentSessionId: 'agent-session:main',
      provider: defaultProviderId,
      externalSessionId: 'provider-session:ready',
      status: 'applied',
      compactionBaseCursor: 'cursor:base',
    });
  });

  it('does not report native DeepAgents compaction success without an adapter compaction prompt', async () => {
    const runAgent = vi.fn(async () => ({ status: 'success', result: 'ok' }));
    const runner = createGroupAgentRunner({
      deps: {
        channelRuntime: {
          hasChannel: () => true,
          supportsStreaming: () => false,
          supportsProgress: () => false,
          sendMessage: async () => {},
          sendStreamingChunk: async () => false,
          resetStreaming: () => {},
          setTyping: async () => {},
          sendProgressUpdate: async () => {},
        },
        queue: {
          enqueueMessageCheck: () => false,
          closeStdin: () => {},
          notifyIdle: () => {},
          registerProcess: () => {},
        },
        getGroup: () => undefined,
        clearSession: async () => {},
        getCursor: () => '',
        setCursor: () => {},
        saveState: async () => {},
        setGroupModelOverride: async () => {},
        setGroupThinkingOverride: async () => {},
        getAvailableGroups: () => [],
        getRegisteredJids: () => new Set(),
        runAgent: runAgent as never,
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: { id: 'deepagents:langchain' } as never,
        getSelectedAgentHarness: () => 'deepagents',
      },
      ops: () =>
        ({
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
          })),
        }) as never,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
          agentConfig: { model: 'gpt-5.5' },
        },
        '',
        'tg:chat',
        'tg:chat',
        undefined,
        {
          maintenanceCompaction: true,
          maintenanceProviderSession: {
            providerSessionId: 'provider-session:locked',
            externalSessionId: 'provider-session:locked',
          },
        },
      ),
    ).resolves.toBe('error');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('renders installed skill metadata without reading full skill artifacts', async () => {
    const skillRepository = {
      listEnabledSkillsForAgent: vi.fn(async () => [
        {
          id: 'skill:release-writer',
          appId: 'app-one',
          agentId: 'agent-one',
          name: 'release-writer',
          description: 'Use for drafting release notes.',
          source: 'admin_uploaded',
          status: 'installed',
          promptRefs: [],
          toolIds: [],
          workflowRefs: [],
          storage: {
            storageType: 'local-filesystem',
            storageRef: 'skills/release-writer',
            contentHash: 'sha256-frontmatter-revision',
            sizeBytes: 1024,
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ]),
    } as unknown as SkillCatalogRepository;
    const skillArtifactStore = {
      getSkillArtifact: vi.fn(async () => ({
        assets: [
          {
            path: 'SKILL.md',
            content: Buffer.from(
              [
                '---',
                'name: release-writer',
                'description: Use for drafting release notes.',
                '---',
                '# Release Writer',
                'FULL BODY INSTRUCTIONS MUST NOT BE INJECTED',
              ].join('\n'),
            ),
          },
        ],
      })),
    } as unknown as SkillArtifactStore;

    const block = await buildApprovedSkillContextBlock({
      skillRepository,
      skillArtifactStore,
      turnContext: {
        appId: 'app-one',
        agentId: 'agent-one',
      },
    });

    expect(skillRepository.listEnabledSkillsForAgent).toHaveBeenCalledWith({
      appId: 'app-one',
      agentId: 'agent-one',
    });
    expect(skillArtifactStore.getSkillArtifact).not.toHaveBeenCalled();
    expect(block).toContain('[[INSTALLED_SKILLS_AVAILABLE_THIS_SESSION]]');
    expect(block).toContain('release-writer (skill:release-writer)');
    expect(block).toContain('description: Use for drafting release notes.');
    expect(block).toContain('revision: sha256-frontmatter-revision');
    expect(block).toContain('progressive disclosure');
    expect(block).not.toContain('```markdown');
    expect(block).not.toContain('FULL BODY INSTRUCTIONS MUST NOT BE INJECTED');
  });

  it('redacts provider session handles from persisted summaries', () => {
    const summary = summarizeRuntimeResultForPersistence(
      [
        'framed {"newSessionId":"json-new-handle","providerSessionId":"provider-session:json-secret","externalSessionId":"claude-session-json-secret","session_id":"snake-json-handle"}',
        'sessionId=session-inline-handle',
        'latestProviderSessionId latest-whitespace-handle',
        'provider-session:standalone-secret',
        'claude-session-standalone-secret',
      ].join(' '),
    ) as string;

    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('json-new-handle');
    expect(summary).not.toContain('provider-session:json-secret');
    expect(summary).not.toContain('claude-session-json-secret');
    expect(summary).not.toContain('snake-json-handle');
    expect(summary).not.toContain('session-inline-handle');
    expect(summary).not.toContain('latest-whitespace-handle');
    expect(summary).not.toContain('provider-session:standalone-secret');
    expect(summary).not.toContain('claude-session-standalone-secret');
  });

  it('caps oversized failed agent run error summaries before persistence', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;
    const errorSummary = `HEAD-START${'x'.repeat(
      RUNTIME_RESULT_SUMMARY_MAX_CHARS + 250,
    )}TAIL-END`;

    await completeFailedRuntimeSessionRun({
      ops,
      runId: 'run-1',
      errorSummary,
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.errorSummary as string;
    expect(summary.length).toBeLessThanOrEqual(
      RUNTIME_RESULT_SUMMARY_MAX_CHARS,
    );
    expect(summary).toMatch(/^\[output truncated; showing tail\]\n/);
    expect(summary).not.toContain('HEAD-START');
    expect(summary.endsWith('TAIL-END')).toBe(true);
  });

  it('does not emit marker-only summaries when max chars cannot hold marker and content', () => {
    const accumulator = createRuntimeResultSummaryAccumulator({ maxChars: 0 });
    accumulator.append('important body');

    expect(accumulator.snapshot()).toBeNull();
  });

  it('keeps content instead of marker-only summaries for tiny truncation limits', () => {
    expect(truncateRuntimeResultSummary('important body', 8)).toBe(
      'important body',
    );
    expect(truncateRuntimeResultSummary('important body', 8)).not.toBe(
      '[output truncated; showing tail]',
    );
  });

  it('redacts completion summaries before storing successful runs', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await completeSuccessfulRuntimeSessionRun({
      ops,
      group: { name: 'Main', folder: 'main_agent' } as never,
      runId: 'run-2',
      result:
        'ok {"newSessionId":"json-success-handle"} sessionId=session-inline-success provider-session:standalone-success',
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.resultSummary as string;
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('json-success-handle');
    expect(summary).not.toContain('session-inline-success');
    expect(summary).not.toContain('provider-session:standalone-success');
  });

  it('redacts provider resume handles before storing failed runs', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await completeFailedRuntimeSessionRun({
      ops,
      runId: 'run-failed-redaction',
      errorSummary:
        'failed latestProviderSessionId=latest-failed provider-session:standalone-failed {"externalSessionId":"claude-session-failed"}',
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.errorSummary as string;
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('latest-failed');
    expect(summary).not.toContain('provider-session:standalone-failed');
    expect(summary).not.toContain('claude-session-failed');
  });

  it('runs errorSummary through full secret redaction before storing failed runs', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await completeFailedRuntimeSessionRun({
      ops,
      runId: 'run-failed-secrets',
      errorSummary:
        'gateway rejected token gtw_secret_abc123 and sk-ant-secret-xyz upstream',
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.errorSummary as string;
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('gtw_secret_abc123');
    expect(summary).not.toContain('sk-ant-secret-xyz');
  });

  it('does not throw when failed run bookkeeping cannot be persisted', async () => {
    const completeSessionAgentRun = vi
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await expect(
      completeFailedRuntimeSessionRun({
        ops,
        runId: 'run-failed-bookkeeping',
        errorSummary: 'permission denied',
      }),
    ).resolves.toBeUndefined();

    expect(completeSessionAgentRun).toHaveBeenCalledWith({
      runId: 'run-failed-bookkeeping',
      status: 'failed',
      errorSummary: 'permission denied',
    });
  });

  it('does not throw when successful run bookkeeping cannot be persisted', async () => {
    const completeSessionAgentRun = vi
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await expect(
      completeSuccessfulRuntimeSessionRun({
        ops,
        group: { name: 'Main', folder: 'main_agent' } as never,
        runId: 'run-success-bookkeeping',
        result: 'done',
      }),
    ).resolves.toBeUndefined();

    expect(completeSessionAgentRun).toHaveBeenCalledWith({
      runId: 'run-success-bookkeeping',
      status: 'completed',
      resultSummary: 'done',
    });
  });

  it('does not persist provider resume handles under the job-owned session scope', async () => {
    const setSession = vi.fn().mockResolvedValue(true);
    const ops = {
      setSession,
    } as unknown as RuntimeAgentSessionRepository;

    await completeSuccessfulRuntimeSessionRun({
      ops,
      group: { name: 'Scheduler', folder: 'scheduler_agent' } as never,
      chatJid: 'tg:scheduler',
      threadId: 'topic-1',
      conversationKind: 'channel',
      jobId: 'job-1',
      agentSessionId: 'agent-session:job-1',
      providerSessionId: 'claude-session-job-1',
      result: 'ok',
    });

    expect(setSession).not.toHaveBeenCalled();
  });
});

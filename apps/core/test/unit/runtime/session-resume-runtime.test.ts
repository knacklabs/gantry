import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentSessionRepository } from '@core/domain/repositories/ops-repo.js';
import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
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

import { describe, expect, it } from 'vitest';

import {
  jobCompletedModelPayload,
  jobStartedModelPayload,
  modelUseKindForJobSchedule,
  resolveJobExecutionProviderId,
  resolveJobModel,
} from '@core/jobs/model-resolution.js';
import { DEFAULT_AGENT_ENGINE } from '@core/shared/agent-engine.js';
import { resolveModelFamilyAlias } from '@core/shared/model-families.js';

describe('job model resolution', () => {
  it('maps manual and once jobs to one-time defaults', () => {
    expect(modelUseKindForJobSchedule('manual')).toBe('oneTimeJob');
    expect(modelUseKindForJobSchedule('once')).toBe('oneTimeJob');
    expect(modelUseKindForJobSchedule('cron')).toBe('recurringJob');
    expect(modelUseKindForJobSchedule('interval')).toBe('recurringJob');
  });

  it('uses explicit job model and emits audit payload details', () => {
    const resolved = resolveJobModel(
      { model: 'sonnet', schedule_type: 'manual' } as never,
      { model: 'opus', source: 'system default' },
    );

    expect(resolved).toMatchObject({
      selectedModel: 'sonnet',
      source: 'job.model',
      entry: {
        recommendedAlias: 'sonnet',
      },
    });
    expect(jobStartedModelPayload(resolved)).toMatchObject({
      resolved_model_alias: 'sonnet',
      resolved_model_profile_id: 'anthropic:sonnet-4.6',
      model_source: 'job.model',
      cache_policy: 'anthropic-prompt',
      context_window_tokens: 1000000,
    });
  });

  it('falls back to default config and carries usage into completion audit', () => {
    const resolved = resolveJobModel(
      { model: null, schedule_type: 'manual' } as never,
      {
        model: 'haiku',
        source: 'settings.yaml agent.one_time_job_default_model',
      },
    );
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalBillableInputTokens: 12,
      cacheProvider: 'anthropic',
      cacheStatus: 'hit',
      at: '2026-05-01T00:00:00.000Z',
    } as const;

    expect(jobCompletedModelPayload(resolved, usage)).toMatchObject({
      usage,
      resolved_model_alias: 'haiku',
      model_source: 'settings.yaml agent.one_time_job_default_model',
      cache_policy: 'anthropic-prompt',
    });
  });

  it('derives resolved-run diagnostics (engine, family, provider id, credential modes) from the model provider', () => {
    const anthropic = resolveJobModel(
      { model: 'opus', schedule_type: 'manual' } as never,
      { model: 'opus', source: 'system default' },
    );
    expect(jobStartedModelPayload(anthropic)).toMatchObject({
      agent_engine: DEFAULT_AGENT_ENGINE,
      response_family: 'anthropic',
      execution_provider_id: 'anthropic:claude-agent-sdk',
    });
    const startPayload = jobStartedModelPayload(anthropic) as {
      supported_credential_modes: string[];
    };
    expect(Array.isArray(startPayload.supported_credential_modes)).toBe(true);
    expect(startPayload.supported_credential_modes.length).toBeGreaterThan(0);
  });

  it('derives the job execution provider from the resolved model provider', () => {
    const anthropicSdk = resolveJobModel(
      { model: 'opus', schedule_type: 'manual' } as never,
      { model: 'opus', source: 'system default' },
    );
    // OpenRouter (kimi) supports jobs and is now the DeepAgents lane.
    const deepagents = resolveJobModel(
      { model: 'kimi', schedule_type: 'manual' } as never,
      { model: 'kimi', source: 'system default' },
    );

    expect(anthropicSdk.agentEngine).toBe('anthropic_sdk');
    expect(deepagents.agentEngine).toBe('deepagents');
    expect(resolveJobExecutionProviderId({ resolvedModel: anthropicSdk })).toBe(
      'anthropic:claude-agent-sdk',
    );
    expect(resolveJobExecutionProviderId({ resolvedModel: deepagents })).toBe(
      'deepagents:langchain',
    );
  });

  it('rejects incompatible explicit agent harness before job spawn', () => {
    const resolved = resolveJobModel(
      { model: 'kimi', schedule_type: 'manual' } as never,
      { model: 'kimi', source: 'system default' },
      'anthropic_sdk',
    );

    expect(resolved.routeResolution).toMatchObject({
      ok: false,
      reason: 'incompatible-harness',
    });
    expect(jobStartedModelPayload(resolved)).toMatchObject({
      agent_harness: 'anthropic_sdk',
      execution_provider_id: null,
    });
    expect(() =>
      resolveJobExecutionProviderId({
        resolvedModel: resolved,
        executionAdapter: { id: 'deepagents:langchain' },
      }),
    ).not.toThrow();
  });

  it('resolves a job whose model is a family alias credential-driven by app providers', () => {
    // The job-seam rewrite (jobs/execution.ts) maps the family alias to a
    // concrete member using the job app's configured providers, then resolves
    // the job model from that concrete alias.
    const rewriteFor = (providers: string[]) =>
      resolveModelFamilyAlias('gpt-oss', {
        isProviderConfigured: (id) => providers.includes(id),
      })?.alias ?? 'gpt-oss';

    const cerebrasOnly = resolveJobModel(
      { model: rewriteFor(['cerebras']), schedule_type: 'cron' } as never,
      { model: 'opus', source: 'system default' },
    );
    expect(cerebrasOnly.entry?.modelRoute.id).toBe('cerebras');
    expect(cerebrasOnly.agentEngine).toBe('deepagents');
    expect(resolveJobExecutionProviderId({ resolvedModel: cerebrasOnly })).toBe(
      'deepagents:langchain',
    );

    const groqConfigured = resolveJobModel(
      { model: rewriteFor(['groq']), schedule_type: 'cron' } as never,
      { model: 'opus', source: 'system default' },
    );
    expect(groqConfigured.entry?.modelRoute.id).toBe('groq');

    // None configured -> first member (loud-failure path), still resolvable.
    const noneConfigured = resolveJobModel(
      { model: rewriteFor([]), schedule_type: 'cron' } as never,
      { model: 'opus', source: 'system default' },
    );
    expect(noneConfigured.entry?.modelRoute.id).toBe('groq');
  });
});

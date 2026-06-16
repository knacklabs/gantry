import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AppId } from '@core/domain/app/app.js';
import type { AgentRunId } from '@core/domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

import {
  LIVE_LATENCY_BENCHMARK_METRIC_NAMES,
  loadLiveLatencyStartupDiagnosticsFromRuntimeEvents,
  runSyntheticLiveLatencyBenchmark,
} from '../harness/live-latency-benchmark.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const BENCHMARK_RUN_ID = 'live-latency-benchmark-itest';

function itemRunIdsByItemId(
  benchmarkRunId: string,
  concurrency: number,
): Map<string, string> {
  return new Map(
    Array.from({ length: concurrency }, (_, index) => [
      `${benchmarkRunId}:admission:${index}`,
      `agent-run:${benchmarkRunId}:${index}`,
    ]),
  );
}

maybeDescribe('live latency benchmark (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_latency_benchmark',
    });
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('rolls up 300 durable live admissions with required startup and UX fields', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const runIdsByItemId = itemRunIdsByItemId(BENCHMARK_RUN_ID, 300);
    const now = new Date().toISOString();
    for (const runId of runIdsByItemId.values()) {
      await runtime.repositories.agentRuns.saveAgentRun({
        id: runId as AgentRunId,
        appId,
        agentId: DEFAULT_AGENT_ID as never,
        configVersionId: `config:${DEFAULT_AGENT_ID}:1` as never,
        llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
        executionProviderId: 'deepagents:langchain' as never,
        permissionDecisionIds: [],
        cause: 'message',
        status: 'running',
        createdAt: now,
        startedAt: now,
      });
      await runtime.repositories.runtimeEvents.appendRuntimeEvent({
        appId,
        runId: runId as AgentRunId,
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
        actor: 'runtime',
        responseMode: 'none',
        payload: {
          provider: 'host',
          diagnostic: 'host_startup_projection',
          hostPhases: {
            mcpProjectionMs: 12,
            sandboxSpecMs: 4,
          },
        },
      });
      await runtime.repositories.runtimeEvents.appendRuntimeEvent({
        appId,
        runId: runId as AgentRunId,
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
        actor: 'runtime',
        responseMode: 'none',
        payload: {
          provider: 'deepagents',
          diagnostic: 'runner_startup',
          checkpointLoadMs: 9,
          checkpointWriteMs: 18,
          firstVisibleOutputMs: 21,
          phases: {
            modelBuildMs: 3,
            mcpConnectMs: 5,
            permissionEnvMs: 1,
          },
        },
      });
      await runtime.repositories.runtimeEvents.appendRuntimeEvent({
        appId,
        runId: runId as AgentRunId,
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
        actor: 'runtime',
        responseMode: 'none',
        payload: {
          provider: 'host',
          diagnostic: 'runner_process_timing',
          sandbox: {
            provider: 'direct',
            enforcing: false,
          },
          exit: {
            code: 0,
            signal: null,
            timedOut: false,
            hadStreamingOutput: true,
          },
          startupTiming: {
            sandboxStartCallMs: 6,
            firstVisibleOutputMs: 31,
            hostPhases: {
              mcpProjectionMs: 12,
              sandboxSpecMs: 4,
            },
          },
        },
      });
    }
    const startupDiagnosticsByItemId =
      await loadLiveLatencyStartupDiagnosticsFromRuntimeEvents({
        runtimeEvents: runtime.repositories.runtimeEvents,
        appId,
        itemRunIdsByItemId: runIdsByItemId,
      });
    const reportArtifactPath = path.join(
      runtime.artifactRoot,
      'reports',
      `${BENCHMARK_RUN_ID}.json`,
    );

    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: runtime.repositories.liveTurns,
      concurrency: 300,
      workerCount: 12,
      claimBatchSize: 25,
      firstVisibleSloMs: 5_000,
      benchmarkRunId: BENCHMARK_RUN_ID,
      startupDiagnosticsByItemId,
      reportArtifactPath,
      syntheticLatenciesMs: {
        hydrationLagMs: 1,
        bridgeLagMs: 1,
        checkpointLoadMs: 2,
        checkpointWriteMs: 3,
        asyncDelegationLaunchAckMs: 1,
        delegationProgressEventMs: 1,
        streamRejoinMs: 1,
        queuedInputWakeMs: 1,
        mcpClientStartupMs: 2,
        toolListingFilteringMs: 2,
        toolSchemaSerializationMs: 2,
        permissionHitlSetupMs: 1,
        sandboxReadinessMs: 1,
        sandboxTemplateMs: 1,
        sandboxSpecMs: 1,
        sandboxStartMs: 1,
        sandboxFirstToolReadyMs: 1,
        modelConstructionMs: 2,
        notifyLagMs: 0,
      },
      sleepMs: async () => undefined,
    });

    expect(report.sampleCount).toBe(300);
    expect(report.concurrency).toBe(300);
    expect(Object.keys(report.metrics).sort()).toEqual(
      [...LIVE_LATENCY_BENCHMARK_METRIC_NAMES].sort(),
    );
    for (const metricName of LIVE_LATENCY_BENCHMARK_METRIC_NAMES) {
      expect(report.metrics[metricName].count).toBe(300);
      expect(report.metrics[metricName].p50).not.toBeNull();
      expect(report.metrics[metricName].p95).not.toBeNull();
      expect(report.metrics[metricName].p99).not.toBeNull();
    }

    expect(report.metrics.acceptedToFirstVisibleMs.p95).toBeLessThanOrEqual(
      5_000,
    );
    expect(report.metrics.checkpointLoadMs).toMatchObject({
      p95: 9,
      source: 'measured',
    });
    expect(report.metrics.checkpointWriteMs).toMatchObject({
      p95: 18,
      source: 'measured',
    });
    expect(report.metrics.mcpClientStartupMs).toMatchObject({
      p95: 5,
      source: 'measured',
    });
    expect(report.metrics.toolListingFilteringMs).toMatchObject({
      p95: 12,
      source: 'measured',
    });
    expect(report.metrics.sandboxSpecMs).toMatchObject({
      p95: 4,
      source: 'measured',
    });
    expect(report.metrics.sandboxStartMs).toMatchObject({
      p95: 6,
      source: 'measured',
    });
    expect(report.syntheticMetricNames).not.toContain('checkpointLoadMs');
    expect(report.syntheticMetricNames).not.toContain('sandboxStartMs');
    expect(report.measuredMetricNames).toContain('admissionLagMs');
    expect(report.measuredMetricNames).toContain('checkpointLoadMs');
    expect(report.measuredMetricNames).toContain('sandboxStartMs');
    expect(report.deferredCount).toBe(0);
    expect(report.degradedCount).toBe(0);
    expect(report.failureCount).toBe(0);
    expect(report.missingMetricNames).toEqual([]);

    const artifact = JSON.parse(fs.readFileSync(reportArtifactPath, 'utf8'));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      benchmarkRunId: BENCHMARK_RUN_ID,
      report: {
        sampleCount: 300,
        measuredMetricNames: expect.arrayContaining([
          'checkpointLoadMs',
          'sandboxStartMs',
        ]),
        syntheticMetricNames: expect.not.arrayContaining([
          'checkpointLoadMs',
          'sandboxStartMs',
        ]),
      },
    });
    expect(artifact.generatedAt).toEqual(expect.any(String));
    expect(artifact.report.metrics.sandboxStartMs).toMatchObject({
      p95: 6,
      source: 'measured',
    });
  });
});

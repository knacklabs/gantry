import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  LiveAdmissionWorkItem,
  LiveAdmissionWorkItemRepository,
} from '@core/domain/ports/live-turns.js';

import {
  LIVE_LATENCY_BENCHMARK_METRIC_NAMES,
  loadLiveLatencyStartupDiagnosticsFromRuntimeEvents,
  liveLatencyBenchmarkReportArtifactPath,
  runSyntheticLiveLatencyBenchmark,
  startupDiagnosticToLiveLatencyMetrics,
  summarizeLiveLatencyBenchmark,
  writeLiveLatencyBenchmarkReportArtifact,
  type LiveLatencyBenchmarkMetricValues,
  type LiveLatencyBenchmarkSample,
} from '../../harness/live-latency-benchmark.js';

function completeMetrics(base: number): LiveLatencyBenchmarkMetricValues {
  return Object.fromEntries(
    LIVE_LATENCY_BENCHMARK_METRIC_NAMES.map((metricName, index) => [
      metricName,
      base + index,
    ]),
  ) as LiveLatencyBenchmarkMetricValues;
}

function sample(
  id: string,
  metrics: LiveLatencyBenchmarkMetricValues,
): LiveLatencyBenchmarkSample {
  return { id, metrics };
}

function createMemoryLiveAdmissions(): LiveAdmissionWorkItemRepository {
  const items = new Map<string, LiveAdmissionWorkItem>();

  return {
    async enqueueLiveAdmissionWorkItem(input) {
      const existing = items.get(input.id);
      if (existing) return { outcome: 'replayed', item: existing };

      const now = input.now ?? new Date().toISOString();
      const item: LiveAdmissionWorkItem = {
        id: input.id,
        appId: input.appId,
        agentId: input.agentId ?? null,
        agentSessionId: input.agentSessionId ?? null,
        conversationId: input.conversationId,
        threadId: input.threadId ?? null,
        queueJid: input.queueJid,
        messageId: input.messageId,
        messageCursor: input.messageCursor,
        senderUserId: input.senderUserId ?? null,
        senderDisplayName: input.senderDisplayName ?? null,
        idempotencyKey: input.idempotencyKey,
        state: 'queued',
        sourceKind: 'message',
        triggerDecision: input.triggerDecision ?? {},
        claimWorkerInstanceId: null,
        claimToken: null,
        claimExpiresAt: null,
        fencingVersion: 0,
        retryCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: now,
        updatedAt: now,
        claimedAt: null,
        endedAt: null,
      };
      items.set(input.id, item);
      return { outcome: 'enqueued', item };
    },
    async claimLiveAdmissionWorkItems(input) {
      const claimed: LiveAdmissionWorkItem[] = [];
      const now = input.now ?? new Date().toISOString();
      for (const item of items.values()) {
        if (claimed.length >= input.limit) break;
        if (item.state !== 'queued') continue;
        const claimedItem: LiveAdmissionWorkItem = {
          ...item,
          state: 'claimed',
          claimWorkerInstanceId: input.workerInstanceId,
          claimToken: input.claimToken,
          claimExpiresAt: input.claimExpiresAt,
          fencingVersion: item.fencingVersion + 1,
          updatedAt: now,
          claimedAt: now,
        };
        items.set(item.id, claimedItem);
        claimed.push(claimedItem);
      }
      return claimed;
    },
    async deferLiveAdmissionWorkItem() {
      return false;
    },
    async settleLiveAdmissionWorkItem(input) {
      const item = items.get(input.id);
      if (
        !item ||
        item.claimToken !== input.claimToken ||
        item.claimWorkerInstanceId !== input.workerInstanceId
      ) {
        return false;
      }
      const now = input.now ?? new Date().toISOString();
      items.set(input.id, {
        ...item,
        state: input.state,
        updatedAt: now,
        endedAt: now,
      });
      return true;
    },
  };
}

describe('live latency benchmark harness', () => {
  it('locks the full launch benchmark metric set', () => {
    expect(LIVE_LATENCY_BENCHMARK_METRIC_NAMES).toEqual([
      'acceptedToFirstVisibleMs',
      'admissionLagMs',
      'hydrationLagMs',
      'bridgeLagMs',
      'checkpointLoadMs',
      'checkpointWriteMs',
      'asyncDelegationLaunchAckMs',
      'delegationProgressEventMs',
      'streamRejoinMs',
      'queuedInputWakeMs',
      'mcpClientStartupMs',
      'toolListingFilteringMs',
      'toolSchemaSerializationMs',
      'permissionHitlSetupMs',
      'retryDelayMs',
      'sandboxReadinessMs',
      'sandboxTemplateMs',
      'sandboxSpecMs',
      'sandboxStartMs',
      'sandboxFirstToolReadyMs',
      'modelConstructionMs',
      'dbPoolWaitMs',
      'lockWaitMs',
      'notifyLagMs',
    ]);
  });

  it('summarizes P50/P95/P99 and keeps checkpoint timing in the rollup', () => {
    const samples = [
      sample('one', {
        ...completeMetrics(1),
        acceptedToFirstVisibleMs: 100,
        checkpointLoadMs: 2,
        checkpointWriteMs: 4,
      }),
      sample('two', {
        ...completeMetrics(10),
        acceptedToFirstVisibleMs: 200,
        checkpointLoadMs: 8,
        checkpointWriteMs: 12,
      }),
      sample('three', {
        ...completeMetrics(20),
        acceptedToFirstVisibleMs: 300,
        checkpointLoadMs: 16,
        checkpointWriteMs: 24,
      }),
      sample('four', {
        ...completeMetrics(30),
        acceptedToFirstVisibleMs: 400,
        checkpointLoadMs: 32,
        checkpointWriteMs: 48,
      }),
    ];

    const report = summarizeLiveLatencyBenchmark({
      concurrency: 4,
      samples,
      firstVisibleSloMs: 350,
    });

    expect(report.metrics.acceptedToFirstVisibleMs).toMatchObject({
      count: 4,
      missing: 0,
      p50: 200,
      p95: 400,
      p99: 400,
      source: 'measured',
    });
    expect(report.metrics.checkpointLoadMs).toMatchObject({
      count: 4,
      p50: 8,
      p95: 32,
      source: 'synthetic',
    });
    expect(report.metrics.checkpointWriteMs).toMatchObject({
      count: 4,
      p50: 12,
      p95: 48,
      source: 'synthetic',
    });
    expect(report.passedFirstVisibleSlo).toBe(false);
    expect(report.missingMetricNames).toEqual([]);
  });

  it('writes a deterministic benchmark report artifact', async () => {
    const artifactRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-live-latency-report-'),
    );
    try {
      const report = summarizeLiveLatencyBenchmark({
        concurrency: 1,
        samples: [
          sample('one', {
            ...completeMetrics(1),
            acceptedToFirstVisibleMs: 42,
          }),
        ],
      });
      const artifactPath = path.join(
        artifactRoot,
        'reports',
        'live-latency.json',
      );

      const artifact = await writeLiveLatencyBenchmarkReportArtifact({
        artifactPath,
        benchmarkRunId: 'benchmark:test',
        generatedAt: '2026-06-16T00:00:00.000Z',
        report,
      });

      expect(artifact).toMatchObject({
        schemaVersion: 1,
        benchmarkRunId: 'benchmark:test',
        generatedAt: '2026-06-16T00:00:00.000Z',
        report: {
          sampleCount: 1,
          metrics: {
            acceptedToFirstVisibleMs: expect.objectContaining({
              p95: 42,
              source: 'measured',
            }),
          },
        },
      });
      const raw = fs.readFileSync(artifactPath, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(JSON.parse(raw)).toEqual(artifact);
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it('uses the factory benchmark artifact path convention', () => {
    expect(
      liveLatencyBenchmarkReportArtifactPath({
        benchmarkRunId: 'live latency/run',
      }),
    ).toBe(
      path.join(
        '.factory',
        'benchmarks',
        'live-latency',
        'live-latency-run.json',
      ),
    );
  });

  it('writes run report artifacts only when requested', async () => {
    const artifactRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-live-latency-run-report-'),
    );
    try {
      const noArtifactDir = path.join(artifactRoot, 'empty');
      fs.mkdirSync(noArtifactDir);

      await runSyntheticLiveLatencyBenchmark({
        liveAdmissions: createMemoryLiveAdmissions(),
        concurrency: 1,
        workerCount: 1,
        claimBatchSize: 1,
        benchmarkRunId: 'artifact/default-off',
        sleepMs: async () => undefined,
      });

      expect(fs.readdirSync(noArtifactDir)).toEqual([]);

      const reportArtifactPath = liveLatencyBenchmarkReportArtifactPath({
        benchmarkRunId: 'artifact/on',
        factoryDir: artifactRoot,
      });
      const report = await runSyntheticLiveLatencyBenchmark({
        liveAdmissions: createMemoryLiveAdmissions(),
        concurrency: 1,
        workerCount: 1,
        claimBatchSize: 1,
        benchmarkRunId: 'artifact/on',
        reportArtifactPath,
        sleepMs: async () => undefined,
      });

      const artifact = JSON.parse(fs.readFileSync(reportArtifactPath, 'utf8'));
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        benchmarkRunId: 'artifact-on',
        report: {
          sampleCount: 1,
          failureCount: 0,
        },
      });
      expect(artifact.report).toEqual(report);
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it('reports missing metric buckets instead of silently treating them as zero', () => {
    const report = summarizeLiveLatencyBenchmark({
      concurrency: 2,
      samples: [
        sample('one', { acceptedToFirstVisibleMs: 10 }),
        sample('two', { acceptedToFirstVisibleMs: 20 }),
      ],
    });

    expect(report.metrics.acceptedToFirstVisibleMs).toMatchObject({
      count: 2,
      p50: 10,
      p95: 20,
    });
    expect(report.metrics.checkpointLoadMs).toMatchObject({
      count: 0,
      missing: 2,
      p50: null,
      p95: null,
    });
    expect(report.missingMetricNames).toContain('checkpointLoadMs');
  });

  it('maps DeepAgents startup diagnostics into measured benchmark metrics', () => {
    const projection = startupDiagnosticToLiveLatencyMetrics(
      {
        provider: 'deepagents',
        diagnostic: 'runner_startup',
        checkpointLoadMs: 9,
        checkpointWriteMs: 18,
        firstVisibleOutputMs: 21,
        phases: {
          modelBuildMs: 3,
          mcpConnectMs: 5,
          permissionEnvMs: 1,
          graphCreateMs: 2,
          streamNormalizeMs: 10,
        },
      },
      { acceptedToRunnerStartMs: 7 },
    );

    expect(projection.metrics).toMatchObject({
      acceptedToFirstVisibleMs: 28,
      checkpointLoadMs: 9,
      checkpointWriteMs: 18,
      modelConstructionMs: 3,
      mcpClientStartupMs: 5,
      permissionHitlSetupMs: 1,
    });
    expect(projection.metricSources).toMatchObject({
      acceptedToFirstVisibleMs: 'measured',
      checkpointLoadMs: 'measured',
      checkpointWriteMs: 'measured',
      modelConstructionMs: 'measured',
      mcpClientStartupMs: 'measured',
      permissionHitlSetupMs: 'measured',
    });
    expect(projection.metrics.bridgeLagMs).toBeUndefined();
  });

  it('maps host startup diagnostics into measured benchmark metrics', () => {
    const projection = startupDiagnosticToLiveLatencyMetrics({
      provider: 'host',
      diagnostic: 'host_startup_projection',
      hostPhases: {
        mcpProjectionMs: 12,
        selectedSkillEnvMs: 3,
        sandboxSpecMs: 4,
      },
    });

    expect(projection.metrics).toMatchObject({
      toolListingFilteringMs: 12,
      sandboxSpecMs: 4,
    });
    expect(projection.metricSources).toMatchObject({
      toolListingFilteringMs: 'measured',
      sandboxSpecMs: 'measured',
    });
    expect(projection.metrics.hydrationLagMs).toBeUndefined();
  });

  it('maps runner process timing diagnostics into measured benchmark metrics', () => {
    const projection = startupDiagnosticToLiveLatencyMetrics(
      {
        provider: 'host',
        diagnostic: 'runner_process_timing',
        startupTiming: {
          sandboxStartCallMs: 6,
          firstVisibleOutputMs: 31,
          hostPhases: {
            mcpProjectionMs: 12,
            sandboxSpecMs: 4,
          },
        },
      },
      { acceptedToRunnerStartMs: 9 },
    );

    expect(projection.metrics).toMatchObject({
      acceptedToFirstVisibleMs: 40,
      sandboxStartMs: 6,
      toolListingFilteringMs: 12,
      sandboxSpecMs: 4,
    });
    expect(projection.metricSources).toMatchObject({
      acceptedToFirstVisibleMs: 'measured',
      sandboxStartMs: 'measured',
      toolListingFilteringMs: 'measured',
      sandboxSpecMs: 'measured',
    });
  });

  it('loads startup diagnostics from persisted runtime events by benchmark run id', async () => {
    const listRuntimeEvents = vi.fn(async () => [
      {
        eventId: 1,
        runId: 'agent-run:benchmark:one',
        payload: {
          provider: 'host',
          diagnostic: 'host_startup_projection',
          hostPhases: { mcpProjectionMs: 12 },
        },
      },
      {
        eventId: 2,
        runId: 'agent-run:unrelated',
        payload: {
          checkpointLoadMs: 999,
        },
      },
      {
        eventId: 3,
        runId: 'agent-run:benchmark:two',
        payload: 'not-object',
      },
    ]);

    const diagnostics =
      await loadLiveLatencyStartupDiagnosticsFromRuntimeEvents({
        runtimeEvents: { listRuntimeEvents } as never,
        appId: 'default',
        itemRunIdsByItemId: new Map([
          ['item-one', 'agent-run:benchmark:one'],
          ['item-two', 'agent-run:benchmark:two'],
        ]),
        pageLimit: 10,
      });

    expect(listRuntimeEvents).toHaveBeenCalledWith({
      appId: 'default',
      eventTypes: ['run.startup_diagnostic'],
      limit: 10,
    });
    expect(diagnostics.get('item-one')).toEqual([
      {
        provider: 'host',
        diagnostic: 'host_startup_projection',
        hostPhases: { mcpProjectionMs: 12 },
      },
    ]);
    expect(diagnostics.has('item-two')).toBe(false);
  });
});

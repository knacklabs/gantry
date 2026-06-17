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
  LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES,
  createPostgresLiveLatencyHotPathObserver,
  loadLiveLatencyStartupDiagnosticsFromRuntimeEvents,
  liveLatencyBenchmarkReportArtifactPath,
  runSyntheticLiveLatencyBenchmark,
  startupDiagnosticToLiveLatencyMetrics,
  summarizeLiveLatencyBenchmark,
  writeLiveLatencyBenchmarkReportArtifact,
  type LiveLatencyBenchmarkMetricEvidenceSources,
  type LiveLatencyBenchmarkMetricSource,
  type LiveLatencyBenchmarkMetricValues,
  type LiveLatencyBenchmarkSample,
  type LiveLatencyReadinessRequiredMetricName,
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
  metricEvidenceSources?: LiveLatencyBenchmarkMetricEvidenceSources,
): LiveLatencyBenchmarkSample {
  return { id, metrics, metricEvidenceSources };
}

function readinessEvidenceSources(
  overrides: Partial<LiveLatencyBenchmarkMetricEvidenceSources> = {},
): LiveLatencyBenchmarkMetricEvidenceSources {
  return {
    acceptedToFirstVisibleMs: 'runner_origin',
    admissionLagMs: 'benchmark_observed',
    poolCheckoutWaitMs: 'pool_checkout_observed',
    queryElapsedMs: 'benchmark_observed',
    transactionElapsedMs: 'benchmark_observed',
    pgLockWaitMs: 'pg_lock_observed',
    liveAdmissionClaimMs: 'benchmark_observed',
    mcpClientStartupMs: 'runner_origin',
    toolListingFilteringMs: 'runtime_origin',
    permissionHitlSetupMs: 'runner_origin',
    sandboxSpecMs: 'runtime_origin',
    sandboxStartMs: 'runner_origin',
    modelConstructionMs: 'runner_origin',
    ...overrides,
  };
}

function measuredReadinessMetricSources(): Partial<
  Record<
    LiveLatencyReadinessRequiredMetricName,
    LiveLatencyBenchmarkMetricSource
  >
> {
  return Object.fromEntries(
    LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES.map((metricName) => [
      metricName,
      'measured',
    ]),
  ) as Partial<
    Record<
      LiveLatencyReadinessRequiredMetricName,
      LiveLatencyBenchmarkMetricSource
    >
  >;
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
        failureCount: 0,
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
        if (item.appId !== input.appId) continue;
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
    async renewLiveAdmissionWorkItemClaim() {
      return true;
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

function backgroundWorkItem(id: string): LiveAdmissionWorkItem {
  return {
    id,
    appId: 'default',
    agentId: null,
    agentSessionId: null,
    conversationId: 'background',
    threadId: null,
    queueJid: 'background',
    messageId: `${id}:message`,
    messageCursor: `${id}:cursor`,
    senderUserId: null,
    senderDisplayName: null,
    idempotencyKey: `${id}:delivery`,
    state: 'claimed',
    sourceKind: 'message',
    triggerDecision: {},
    claimWorkerInstanceId: 'background-worker',
    claimToken: 'background-token',
    claimExpiresAt: '2999-01-01T00:00:00.000Z',
    fencingVersion: 1,
    retryCount: 1,
    failureCount: 0,
    deferUntil: null,
    deferredReason: null,
    createdAt: '2999-01-01T00:00:00.000Z',
    updatedAt: '2999-01-01T00:00:00.000Z',
    claimedAt: '2999-01-01T00:00:00.000Z',
    endedAt: null,
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
      'providerSessionReadMs',
      'providerSessionWriteMs',
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
      'poolCheckoutWaitMs',
      'queryElapsedMs',
      'transactionElapsedMs',
      'pgLockWaitMs',
      'liveAdmissionClaimMs',
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
      source: 'synthetic',
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
              source: 'synthetic',
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

  it('fails readiness when required metrics are still synthetic', () => {
    const report = summarizeLiveLatencyBenchmark({
      concurrency: 1,
      samples: [
        sample('one', {
          ...completeMetrics(1),
          acceptedToFirstVisibleMs: 42,
        }),
      ],
    });

    expect(report.passedFirstVisibleSlo).toBe(true);
    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failedMetricNames).toContain('mcpClientStartupMs');
    expect(report.readiness.metrics.mcpClientStartupMs.failureReasons).toEqual(
      expect.arrayContaining(['synthetic_metric']),
    );
    expect(report.readiness.nonReadinessSyntheticMetricNames).toContain(
      'hydrationLagMs',
    );
  });

  it('fails readiness when a required metric is missing from one sample', () => {
    const metrics = completeMetrics(1);
    delete metrics.modelConstructionMs;

    const report = summarizeLiveLatencyBenchmark({
      concurrency: 1,
      samples: [sample('one', metrics, readinessEvidenceSources())],
      metricSources: measuredReadinessMetricSources(),
    });

    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failedMetricNames).toContain('modelConstructionMs');
    expect(report.readiness.metrics.modelConstructionMs.failureReasons).toEqual(
      expect.arrayContaining(['missing_metric']),
    );
  });

  it('fails readiness when measured startup metrics are fixture seeded', () => {
    const seededEvidence = Object.fromEntries(
      LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES.map((metricName) => [
        metricName,
        'fixture_seeded',
      ]),
    ) as LiveLatencyBenchmarkMetricEvidenceSources;
    const report = summarizeLiveLatencyBenchmark({
      concurrency: 1,
      samples: [sample('one', completeMetrics(1), seededEvidence)],
      metricSources: measuredReadinessMetricSources(),
    });

    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failedMetricNames).toContain(
      'acceptedToFirstVisibleMs',
    );
    expect(
      report.readiness.metrics.acceptedToFirstVisibleMs.failureReasons,
    ).toEqual(expect.arrayContaining(['untrusted_evidence_source']));
    expect(
      report.readiness.metrics.acceptedToFirstVisibleMs.evidenceSourceCounts
        .fixture_seeded,
    ).toBe(1);
  });

  it('requires dedicated evidence sources for pool checkout and Postgres lock waits', () => {
    const report = summarizeLiveLatencyBenchmark({
      concurrency: 1,
      samples: [
        sample(
          'one',
          {
            ...completeMetrics(1),
            acceptedToFirstVisibleMs: 42,
          },
          readinessEvidenceSources({
            poolCheckoutWaitMs: 'benchmark_observed',
            pgLockWaitMs: 'benchmark_observed',
          }),
        ),
      ],
      metricSources: measuredReadinessMetricSources(),
    });

    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failedMetricNames).toEqual(
      expect.arrayContaining(['poolCheckoutWaitMs', 'pgLockWaitMs']),
    );
    expect(report.readiness.metrics.poolCheckoutWaitMs.failureReasons).toEqual(
      expect.arrayContaining(['untrusted_evidence_source']),
    );
    expect(report.readiness.metrics.pgLockWaitMs.failureReasons).toEqual(
      expect.arrayContaining(['untrusted_evidence_source']),
    );
  });

  it('passes readiness only when all required metrics have trusted measured evidence', () => {
    const samples = Array.from({ length: 300 }, (_, index) =>
      sample(
        `sample-${index}`,
        {
          ...completeMetrics(index + 1),
          acceptedToFirstVisibleMs: 100 + index,
        },
        readinessEvidenceSources(),
      ),
    );

    const report = summarizeLiveLatencyBenchmark({
      concurrency: 300,
      samples,
      metricSources: measuredReadinessMetricSources(),
      firstVisibleSloMs: 5_000,
    });

    expect(report.readiness.passed).toBe(true);
    expect(report.readiness.failedMetricNames).toEqual([]);
    expect(report.readiness.requiredMetricNames).toEqual(
      LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES,
    );
    expect(report.readiness.nonReadinessSyntheticMetricNames).toContain(
      'hydrationLagMs',
    );
  });

  it('maps repository timings without fabricating pool or lock wait', async () => {
    let now = 1_000;
    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createMemoryLiveAdmissions(),
      concurrency: 1,
      workerCount: 1,
      claimBatchSize: 1,
      benchmarkRunId: 'db-taxonomy',
      nowMs: () => {
        now += 5;
        return now;
      },
      sleepMs: async () => undefined,
    });

    expect(report.metrics.queryElapsedMs).toMatchObject({
      count: 1,
      missing: 0,
      source: 'measured',
    });
    expect(report.metrics.transactionElapsedMs).toMatchObject({
      count: 1,
      missing: 0,
      source: 'measured',
    });
    expect(report.metrics.liveAdmissionClaimMs).toMatchObject({
      count: 1,
      missing: 0,
      source: 'measured',
    });
    expect(report.metrics.poolCheckoutWaitMs).toMatchObject({
      count: 0,
      missing: 1,
      source: 'synthetic',
    });
    expect(report.metrics.pgLockWaitMs).toMatchObject({
      count: 0,
      missing: 1,
      source: 'synthetic',
    });
    expect(
      (report.metrics as Record<string, unknown>).dbPoolWaitMs,
    ).toBeUndefined();
    expect(
      (report.metrics as Record<string, unknown>).lockWaitMs,
    ).toBeUndefined();
    expect(report.readiness.failedMetricNames).toEqual(
      expect.arrayContaining(['poolCheckoutWaitMs', 'pgLockWaitMs']),
    );
  });

  it('uses trusted Postgres hot-path observations when provided', async () => {
    const measurePoolCheckoutWaitMs = vi.fn(async () => 7);
    const measurePgLockWaitMs = vi.fn(async () => 0);
    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createMemoryLiveAdmissions(),
      concurrency: 2,
      workerCount: 1,
      claimBatchSize: 2,
      benchmarkRunId: 'db-observed',
      postgresHotPathObserver: {
        measurePoolCheckoutWaitMs,
        measurePgLockWaitMs,
      },
      sleepMs: async () => undefined,
    });

    expect(report.metrics.poolCheckoutWaitMs).toMatchObject({
      count: 2,
      missing: 0,
      p50: 7,
      source: 'measured',
    });
    expect(report.metrics.pgLockWaitMs).toMatchObject({
      count: 2,
      missing: 0,
      p50: 0,
      source: 'measured',
    });
    expect(report.readiness.failedMetricNames).not.toContain(
      'poolCheckoutWaitMs',
    );
    expect(report.readiness.failedMetricNames).not.toContain('pgLockWaitMs');
    expect(measurePoolCheckoutWaitMs).toHaveBeenCalledTimes(2);
    expect(measurePgLockWaitMs).toHaveBeenCalledTimes(2);
  });

  it('measures provider-session operations as benchmark-observed metrics', async () => {
    let now = 100;
    const read = vi.fn(async () => undefined);
    const write = vi.fn(async () => undefined);
    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createMemoryLiveAdmissions(),
      concurrency: 2,
      workerCount: 1,
      claimBatchSize: 2,
      benchmarkRunId: 'provider-sessions',
      providerSessionOperations: { read, write },
      nowMs: () => {
        now += 5;
        return now;
      },
      sleepMs: async () => undefined,
    });

    expect(report.metrics.providerSessionReadMs).toMatchObject({
      count: 2,
      missing: 0,
      p50: 5,
      source: 'measured',
    });
    expect(report.metrics.providerSessionWriteMs).toMatchObject({
      count: 2,
      missing: 0,
      p50: 5,
      source: 'measured',
    });
    expect(report.measuredMetricNames).toContain('providerSessionReadMs');
    expect(report.measuredMetricNames).toContain('providerSessionWriteMs');
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[0]).toEqual({
      sampleId: 'provider-sessions:admission:0',
    });
  });

  it('counts seeded background claims and bounds any allowance', async () => {
    function createLiveAdmissionsWithSeededBackgroundClaim() {
      const liveAdmissions = createMemoryLiveAdmissions();
      const claimSamples =
        liveAdmissions.claimLiveAdmissionWorkItems.bind(liveAdmissions);
      let returnedBackground = false;
      liveAdmissions.claimLiveAdmissionWorkItems = async (input) => {
        if (!returnedBackground) {
          returnedBackground = true;
          return [backgroundWorkItem('background')];
        }
        return claimSamples(input);
      };
      return liveAdmissions;
    }

    const failingReport = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createLiveAdmissionsWithSeededBackgroundClaim(),
      concurrency: 1,
      workerCount: 1,
      claimBatchSize: 1,
      benchmarkRunId: 'background-claims-disallowed',
      sleepMs: async () => undefined,
    });

    expect(failingReport.sampleCount).toBe(1);
    expect(failingReport.backgroundClaimCount).toBe(1);
    expect(failingReport.failureCount).toBe(1);
    expect(failingReport.readiness.failureReasons).toEqual(
      expect.arrayContaining(['benchmark_failure']),
    );

    const rowVolumeReport = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createLiveAdmissionsWithSeededBackgroundClaim(),
      concurrency: 1,
      workerCount: 1,
      claimBatchSize: 1,
      benchmarkRunId: 'background-claims-bounded',
      maxBackgroundClaimCount: 1,
      sleepMs: async () => undefined,
    });

    expect(rowVolumeReport.sampleCount).toBe(1);
    expect(rowVolumeReport.backgroundClaimCount).toBe(1);
    expect(rowVolumeReport.failureCount).toBe(0);
  });

  it('measures pool checkout and sampled Postgres lock wait from a pool', async () => {
    let now = 100;
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => {
        now = 106;
        return { release };
      }),
      query: vi.fn(async () => ({
        rows: [{ max_lock_wait_ms: '3.6' }],
      })),
    };
    const observer = createPostgresLiveLatencyHotPathObserver(pool, () => now);

    await expect(observer.measurePoolCheckoutWaitMs()).resolves.toBe(6);
    expect(release).toHaveBeenCalledOnce();
    await expect(observer.measurePgLockWaitMs()).resolves.toBe(4);
    expect(pool.query.mock.calls[0]?.[0]).toContain('pg_stat_activity');
    expect(pool.query.mock.calls[0]?.[0]).toContain('pg_locks');
    expect(pool.query.mock.calls[0]?.[0]).toContain('waitstart');
    expect(pool.query.mock.calls[0]?.[0]).not.toContain('query_start');
  });

  it('keeps diagnostic-shaped fixture payloads out of readiness', async () => {
    const diagnosticsByItemId = new Map(
      Array.from({ length: 300 }, (_, index) => [
        `mixed-origin:admission:${index}`,
        [
          {
            provider: 'host',
            diagnostic: 'host_startup_projection',
            hostPhases: {
              mcpProjectionMs: 12,
              sandboxSpecMs: 4,
            },
          },
          {
            provider: 'deepagents',
            diagnostic: 'runner_startup',
            firstVisibleOutputMs: 21,
            phases: {
              modelBuildMs: 3,
              mcpConnectMs: 5,
              permissionEnvMs: 1,
            },
          },
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
        ],
      ]),
    );

    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createMemoryLiveAdmissions(),
      concurrency: 300,
      workerCount: 12,
      claimBatchSize: 25,
      benchmarkRunId: 'mixed-origin',
      startupDiagnosticsByItemId: diagnosticsByItemId,
      sleepMs: async () => undefined,
    });

    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failedMetricNames).toEqual(
      expect.arrayContaining([
        'acceptedToFirstVisibleMs',
        'mcpClientStartupMs',
        'toolListingFilteringMs',
        'sandboxSpecMs',
        'sandboxStartMs',
        'modelConstructionMs',
      ]),
    );
    expect(
      report.readiness.metrics.acceptedToFirstVisibleMs.evidenceSourceCounts
        .fixture_seeded,
    ).toBe(300);
    expect(
      report.readiness.metrics.toolListingFilteringMs.evidenceSourceCounts
        .fixture_seeded,
    ).toBe(300);
    expect(
      report.readiness.metrics.sandboxSpecMs.evidenceSourceCounts
        .fixture_seeded,
    ).toBe(300);
  });

  it('does not mark fixture-seeded readiness metrics as measured report evidence', async () => {
    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createMemoryLiveAdmissions(),
      concurrency: 1,
      workerCount: 1,
      claimBatchSize: 1,
      benchmarkRunId: 'fixture-seeded',
      startupDiagnosticsByItemId: new Map([
        [
          'fixture-seeded:admission:0',
          [
            {
              provider: 'deepagents',
              diagnostic: 'runner_startup',
              firstVisibleOutputMs: 21,
              phases: {
                modelBuildMs: 3,
                mcpConnectMs: 5,
                permissionEnvMs: 1,
              },
            },
          ],
        ],
      ]),
      sleepMs: async () => undefined,
    });

    expect(report.passedFirstVisibleSlo).toBe(true);
    expect(report.readiness.passed).toBe(false);
    expect(report.metrics.mcpClientStartupMs.source).toBe('synthetic');
    expect(report.measuredMetricNames).not.toContain('mcpClientStartupMs');
    expect(report.readiness.metrics.mcpClientStartupMs.failureReasons).toEqual(
      expect.arrayContaining(['synthetic_metric', 'untrusted_evidence_source']),
    );
  });

  it('does not trust caller-supplied runtime-event annotations', async () => {
    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createMemoryLiveAdmissions(),
      concurrency: 1,
      workerCount: 1,
      claimBatchSize: 1,
      benchmarkRunId: 'caller-annotated',
      startupDiagnosticsByItemId: new Map([
        [
          'caller-annotated:admission:0',
          [
            {
              payload: {
                provider: 'deepagents',
                diagnostic: 'runner_startup',
                firstVisibleOutputMs: 21,
                phases: {
                  modelBuildMs: 3,
                  mcpConnectMs: 5,
                  permissionEnvMs: 1,
                },
              },
              evidenceMode: 'trusted_runtime_events',
            },
          ],
        ],
      ]),
      sleepMs: async () => undefined,
    });

    expect(report.metrics.mcpClientStartupMs.source).toBe('synthetic');
    expect(report.readiness.metrics.mcpClientStartupMs.failureReasons).toEqual(
      expect.arrayContaining(['synthetic_metric', 'untrusted_evidence_source']),
    );
  });

  it('uses loader-owned runtime-event annotations for startup readiness evidence', async () => {
    const startupDiagnosticsByItemId =
      await loadLiveLatencyStartupDiagnosticsFromRuntimeEvents({
        runtimeEvents: {
          listRuntimeEvents: vi.fn(async () => [
            {
              eventId: 1,
              runId: 'agent-run:trusted-startup:0',
              payload: {
                provider: 'host',
                diagnostic: 'host_startup_projection',
                hostPhases: {
                  mcpProjectionMs: 12,
                  sandboxSpecMs: 4,
                },
              },
            },
            {
              eventId: 2,
              runId: 'agent-run:trusted-startup:0',
              payload: {
                provider: 'deepagents',
                diagnostic: 'runner_startup',
                firstVisibleOutputMs: 21,
                phases: {
                  modelBuildMs: 3,
                  mcpConnectMs: 5,
                  permissionEnvMs: 1,
                },
              },
            },
            {
              eventId: 3,
              runId: 'agent-run:trusted-startup:0',
              payload: {
                provider: 'host',
                diagnostic: 'runner_process_timing',
                startupTiming: {
                  sandboxStartCallMs: 6,
                },
              },
            },
          ]),
        } as never,
        appId: 'default',
        itemRunIdsByItemId: new Map([
          ['trusted-startup:admission:0', 'agent-run:trusted-startup:0'],
        ]),
      });

    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: createMemoryLiveAdmissions(),
      concurrency: 1,
      workerCount: 1,
      claimBatchSize: 1,
      benchmarkRunId: 'trusted-startup',
      startupDiagnosticsByItemId,
      postgresHotPathObserver: {
        measurePoolCheckoutWaitMs: async () => 0,
        measurePgLockWaitMs: async () => 0,
      },
      sleepMs: async () => undefined,
    });

    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failedMetricNames).toEqual([]);
    expect(report.readiness.failureReasons).toEqual(['synthetic_benchmark']);
    expect(report.metrics.acceptedToFirstVisibleMs.source).toBe('measured');
    expect(
      report.readiness.metrics.acceptedToFirstVisibleMs.evidenceSourceCounts
        .runner_origin,
    ).toBe(1);
    expect(
      report.readiness.metrics.toolListingFilteringMs.evidenceSourceCounts
        .runtime_origin,
    ).toBe(1);
    expect(
      report.readiness.metrics.sandboxSpecMs.evidenceSourceCounts
        .runtime_origin,
    ).toBe(1);
  });

  it('fails readiness for deferred or degraded benchmark samples', () => {
    const report = summarizeLiveLatencyBenchmark({
      concurrency: 1,
      samples: [
        sample(
          'one',
          {
            ...completeMetrics(1),
            acceptedToFirstVisibleMs: 42,
          },
          readinessEvidenceSources(),
        ),
      ],
      metricSources: measuredReadinessMetricSources(),
      deferredCount: 1,
      degradedCount: 1,
    });

    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failureReasons).toEqual(
      expect.arrayContaining(['benchmark_deferred', 'benchmark_degraded']),
    );
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
    expect(projection.metricEvidenceSources).toMatchObject({
      acceptedToFirstVisibleMs: 'fixture_seeded',
      checkpointLoadMs: 'fixture_seeded',
      checkpointWriteMs: 'fixture_seeded',
      modelConstructionMs: 'fixture_seeded',
      mcpClientStartupMs: 'fixture_seeded',
      permissionHitlSetupMs: 'fixture_seeded',
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
        sandboxTemplateMs: 2,
        sandboxSpecMs: 4,
      },
    });

    expect(projection.metrics).toMatchObject({
      toolListingFilteringMs: 12,
      sandboxTemplateMs: 2,
      sandboxSpecMs: 4,
    });
    expect(projection.metricSources).toMatchObject({
      toolListingFilteringMs: 'measured',
      sandboxTemplateMs: 'measured',
      sandboxSpecMs: 'measured',
    });
    expect(projection.metricEvidenceSources).toMatchObject({
      toolListingFilteringMs: 'fixture_seeded',
      sandboxTemplateMs: 'fixture_seeded',
      sandboxSpecMs: 'fixture_seeded',
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
            sandboxTemplateMs: 2,
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
      sandboxTemplateMs: 2,
      sandboxSpecMs: 4,
    });
    expect(projection.metricSources).toMatchObject({
      acceptedToFirstVisibleMs: 'measured',
      sandboxStartMs: 'measured',
      toolListingFilteringMs: 'measured',
      sandboxTemplateMs: 'measured',
      sandboxSpecMs: 'measured',
    });
    expect(projection.metricEvidenceSources).toMatchObject({
      acceptedToFirstVisibleMs: 'fixture_seeded',
      sandboxStartMs: 'fixture_seeded',
      toolListingFilteringMs: 'fixture_seeded',
      sandboxTemplateMs: 'fixture_seeded',
      sandboxSpecMs: 'fixture_seeded',
    });
  });

  it('maps Anthropic SDK runner startup timing into accepted-to-first-visible metrics', () => {
    const projection = startupDiagnosticToLiveLatencyMetrics(
      {
        provider: ['anthropic', 'sdk'].join('_'),
        diagnostic: 'runner_startup_timing',
        sdkQueryPreparedMs: 2,
        sdkQueryIteratorMs: 3,
        providerSessionMs: 4,
        firstVisibleOutputMs: 17,
        firstResultMs: 23,
      },
      { acceptedToRunnerStartMs: 8 },
    );

    expect(projection.metrics).toMatchObject({
      acceptedToFirstVisibleMs: 25,
    });
    expect(projection.metricSources).toMatchObject({
      acceptedToFirstVisibleMs: 'measured',
    });
    expect(projection.metricEvidenceSources).toMatchObject({
      acceptedToFirstVisibleMs: 'fixture_seeded',
    });
  });

  it('does not trust diagnostic shape as readiness evidence', () => {
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

    expect(projection.metricEvidenceSources).toMatchObject({
      acceptedToFirstVisibleMs: 'fixture_seeded',
      toolListingFilteringMs: 'fixture_seeded',
      sandboxSpecMs: 'fixture_seeded',
      sandboxStartMs: 'fixture_seeded',
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
    expect(diagnostics.get('item-one')).toMatchObject([
      {
        payload: {
          provider: 'host',
          diagnostic: 'host_startup_projection',
          hostPhases: { mcpProjectionMs: 12 },
        },
        evidenceMode: 'trusted_runtime_events',
      },
    ]);
    expect(diagnostics.has('item-two')).toBe(false);
  });
});

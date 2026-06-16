import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  LiveAdmissionWorkItemRepository,
  LiveAdmissionWorkItemState,
} from '@core/domain/ports/live-turns.js';
import type { AppId } from '@core/domain/app/app.js';
import type { RuntimeEventId } from '@core/domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { RuntimeEventRepository } from '@core/domain/ports/repositories.js';

export const LIVE_LATENCY_BENCHMARK_METRIC_NAMES = [
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
] as const;

export type LiveLatencyBenchmarkMetricName =
  (typeof LIVE_LATENCY_BENCHMARK_METRIC_NAMES)[number];

export type LiveLatencyBenchmarkMetricSource = 'measured' | 'synthetic';

export type LiveLatencyBenchmarkMetricValues = Partial<
  Record<LiveLatencyBenchmarkMetricName, number>
>;

export interface LiveLatencyBenchmarkSample {
  id: string;
  metrics: LiveLatencyBenchmarkMetricValues;
}

export interface LiveLatencyBenchmarkMetricSummary {
  count: number;
  missing: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  source: LiveLatencyBenchmarkMetricSource;
}

export interface LiveLatencyBenchmarkReport {
  concurrency: number;
  sampleCount: number;
  firstVisibleSloMs: number;
  passedFirstVisibleSlo: boolean;
  metrics: Record<
    LiveLatencyBenchmarkMetricName,
    LiveLatencyBenchmarkMetricSummary
  >;
  measuredMetricNames: LiveLatencyBenchmarkMetricName[];
  syntheticMetricNames: LiveLatencyBenchmarkMetricName[];
  missingMetricNames: LiveLatencyBenchmarkMetricName[];
  deferredCount: number;
  degradedCount: number;
  failureCount: number;
}

export interface LiveLatencyBenchmarkReportArtifact {
  schemaVersion: 1;
  benchmarkRunId: string;
  generatedAt: string;
  report: LiveLatencyBenchmarkReport;
}

export interface LiveLatencyBenchmarkSummaryInput {
  concurrency: number;
  samples: LiveLatencyBenchmarkSample[];
  firstVisibleSloMs?: number;
  metricSources?: Partial<
    Record<LiveLatencyBenchmarkMetricName, LiveLatencyBenchmarkMetricSource>
  >;
  deferredCount?: number;
  degradedCount?: number;
  failureCount?: number;
}

export interface StartupDiagnosticToLiveLatencyMetricsOptions {
  acceptedToRunnerStartMs?: number;
}

export interface LiveLatencyBenchmarkDiagnosticProjection {
  metrics: LiveLatencyBenchmarkMetricValues;
  metricSources: Partial<
    Record<LiveLatencyBenchmarkMetricName, LiveLatencyBenchmarkMetricSource>
  >;
}

export interface LiveLatencyStartupDiagnosticsFromRuntimeEventsInput {
  runtimeEvents: RuntimeEventRepository;
  appId: string;
  itemRunIdsByItemId: ReadonlyMap<string, string>;
  afterEventId?: RuntimeEventId;
  pageLimit?: number;
  maxEvents?: number;
}

export interface SyntheticLiveLatencyBenchmarkInput {
  liveAdmissions: LiveAdmissionWorkItemRepository;
  concurrency?: number;
  workerCount?: number;
  claimBatchSize?: number;
  claimTtlMs?: number;
  firstVisibleSloMs?: number;
  benchmarkRunId?: string;
  startupDiagnosticsByItemId?: ReadonlyMap<
    string,
    readonly Record<string, unknown>[]
  >;
  reportArtifactPath?: string;
  syntheticLatenciesMs?: Partial<
    Record<LiveLatencyBenchmarkMetricName, number>
  >;
  nowMs?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
}

export interface WriteLiveLatencyBenchmarkReportArtifactInput {
  artifactPath: string;
  benchmarkRunId: string;
  generatedAt: string;
  report: LiveLatencyBenchmarkReport;
}

export interface LiveLatencyBenchmarkReportArtifactPathInput {
  benchmarkRunId: string;
  factoryDir?: string;
}

const DEFAULT_FIRST_VISIBLE_SLO_MS = 5_000;
const DEFAULT_CONCURRENCY = 300;
const DEFAULT_WORKER_COUNT = 12;
const DEFAULT_CLAIM_BATCH_SIZE = 25;
const DEFAULT_CLAIM_TTL_MS = 30_000;

const DEFAULT_METRIC_SOURCES: Record<
  LiveLatencyBenchmarkMetricName,
  LiveLatencyBenchmarkMetricSource
> = {
  acceptedToFirstVisibleMs: 'measured',
  admissionLagMs: 'measured',
  hydrationLagMs: 'synthetic',
  bridgeLagMs: 'synthetic',
  checkpointLoadMs: 'synthetic',
  checkpointWriteMs: 'synthetic',
  asyncDelegationLaunchAckMs: 'synthetic',
  delegationProgressEventMs: 'synthetic',
  streamRejoinMs: 'synthetic',
  queuedInputWakeMs: 'synthetic',
  mcpClientStartupMs: 'synthetic',
  toolListingFilteringMs: 'synthetic',
  toolSchemaSerializationMs: 'synthetic',
  permissionHitlSetupMs: 'synthetic',
  retryDelayMs: 'synthetic',
  sandboxReadinessMs: 'synthetic',
  sandboxTemplateMs: 'synthetic',
  sandboxSpecMs: 'synthetic',
  sandboxStartMs: 'synthetic',
  sandboxFirstToolReadyMs: 'synthetic',
  modelConstructionMs: 'synthetic',
  dbPoolWaitMs: 'measured',
  lockWaitMs: 'measured',
  notifyLagMs: 'synthetic',
};

const BEFORE_FIRST_VISIBLE_SYNTHETIC_METRICS = [
  'hydrationLagMs',
  'bridgeLagMs',
  'checkpointLoadMs',
  'checkpointWriteMs',
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
] as const satisfies readonly LiveLatencyBenchmarkMetricName[];

function nearestRankPercentile(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function normalizeMetricValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function assignMeasuredMetric(
  projection: LiveLatencyBenchmarkDiagnosticProjection,
  metricName: LiveLatencyBenchmarkMetricName,
  value: unknown,
): void {
  const normalized = normalizeMetricValue(value);
  if (normalized === undefined) return;
  projection.metrics[metricName] = normalized;
  projection.metricSources[metricName] = 'measured';
}

export function startupDiagnosticToLiveLatencyMetrics(
  payload: Record<string, unknown>,
  options: StartupDiagnosticToLiveLatencyMetricsOptions = {},
): LiveLatencyBenchmarkDiagnosticProjection {
  const projection: LiveLatencyBenchmarkDiagnosticProjection = {
    metrics: {},
    metricSources: {},
  };
  const phases = readObject(payload.phases);
  const hostPhases = readObject(payload.hostPhases);
  const startupTiming = readObject(payload.startupTiming);
  const startupTimingHostPhases = readObject(startupTiming?.hostPhases);

  assignMeasuredMetric(
    projection,
    'checkpointLoadMs',
    payload.checkpointLoadMs,
  );
  assignMeasuredMetric(
    projection,
    'checkpointWriteMs',
    payload.checkpointWriteMs,
  );

  if (phases) {
    assignMeasuredMetric(
      projection,
      'modelConstructionMs',
      phases.modelBuildMs,
    );
    assignMeasuredMetric(projection, 'mcpClientStartupMs', phases.mcpConnectMs);
    assignMeasuredMetric(
      projection,
      'permissionHitlSetupMs',
      phases.permissionEnvMs,
    );
  }

  if (hostPhases) {
    assignMeasuredMetric(
      projection,
      'toolListingFilteringMs',
      hostPhases.mcpProjectionMs,
    );
    assignMeasuredMetric(projection, 'sandboxSpecMs', hostPhases.sandboxSpecMs);
  }

  if (startupTiming) {
    assignMeasuredMetric(
      projection,
      'sandboxStartMs',
      startupTiming.sandboxStartCallMs,
    );
    assignMeasuredMetric(
      projection,
      'sandboxSpecMs',
      startupTimingHostPhases?.sandboxSpecMs,
    );
    assignMeasuredMetric(
      projection,
      'toolListingFilteringMs',
      startupTimingHostPhases?.mcpProjectionMs,
    );
  }

  const acceptedToRunnerStartMs = normalizeMetricValue(
    options.acceptedToRunnerStartMs,
  );
  const runnerFirstVisibleMs = normalizeMetricValue(
    payload.firstVisibleOutputMs ?? startupTiming?.firstVisibleOutputMs,
  );
  if (
    acceptedToRunnerStartMs !== undefined &&
    runnerFirstVisibleMs !== undefined
  ) {
    assignMeasuredMetric(
      projection,
      'acceptedToFirstVisibleMs',
      acceptedToRunnerStartMs + runnerFirstVisibleMs,
    );
  }

  return projection;
}

export async function loadLiveLatencyStartupDiagnosticsFromRuntimeEvents(
  input: LiveLatencyStartupDiagnosticsFromRuntimeEventsInput,
): Promise<Map<string, readonly Record<string, unknown>[]>> {
  const expectedRunIds = new Set(
    [...input.itemRunIdsByItemId.values()]
      .map((runId) => runId.trim())
      .filter((runId) => runId.length > 0),
  );
  const diagnosticsByRunId = new Map<string, Record<string, unknown>[]>();
  if (expectedRunIds.size === 0) return new Map();

  const pageLimit = Math.max(1, Math.min(input.pageLimit ?? 1_000, 5_000));
  const maxEvents = Math.max(
    pageLimit,
    input.maxEvents ?? Math.max(pageLimit, expectedRunIds.size * 4),
  );
  let afterEventId = input.afterEventId;
  let scannedCount = 0;

  while (scannedCount < maxEvents) {
    const limit = Math.min(pageLimit, maxEvents - scannedCount);
    const events = await input.runtimeEvents.listRuntimeEvents({
      appId: input.appId as AppId,
      ...(afterEventId !== undefined ? { afterEventId } : {}),
      eventTypes: [RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC],
      limit,
    });
    if (events.length === 0) break;

    scannedCount += events.length;
    afterEventId = events[events.length - 1]?.eventId;
    for (const event of events) {
      const runId = event.runId ? String(event.runId) : '';
      if (!expectedRunIds.has(runId)) continue;
      const payload = readObject(event.payload);
      if (!payload) continue;
      const diagnostics = diagnosticsByRunId.get(runId) ?? [];
      diagnostics.push(payload);
      diagnosticsByRunId.set(runId, diagnostics);
    }
    if (events.length < limit) break;
  }

  const diagnosticsByItemId = new Map<
    string,
    readonly Record<string, unknown>[]
  >();
  for (const [itemId, runId] of input.itemRunIdsByItemId.entries()) {
    const diagnostics = diagnosticsByRunId.get(runId);
    if (diagnostics?.length) diagnosticsByItemId.set(itemId, diagnostics);
  }
  return diagnosticsByItemId;
}

function summarizeMetric(input: {
  samples: LiveLatencyBenchmarkSample[];
  metricName: LiveLatencyBenchmarkMetricName;
  source: LiveLatencyBenchmarkMetricSource;
}): LiveLatencyBenchmarkMetricSummary {
  const values = input.samples
    .map((sample) => normalizeMetricValue(sample.metrics[input.metricName]))
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) {
    return {
      count: 0,
      missing: input.samples.length,
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      source: input.source,
    };
  }

  return {
    count: values.length,
    missing: input.samples.length - values.length,
    min: Math.min(...values),
    p50: nearestRankPercentile(values, 50),
    p95: nearestRankPercentile(values, 95),
    p99: nearestRankPercentile(values, 99),
    max: Math.max(...values),
    source: input.source,
  };
}

export function summarizeLiveLatencyBenchmark(
  input: LiveLatencyBenchmarkSummaryInput,
): LiveLatencyBenchmarkReport {
  const firstVisibleSloMs =
    input.firstVisibleSloMs ?? DEFAULT_FIRST_VISIBLE_SLO_MS;
  const metricSources = {
    ...DEFAULT_METRIC_SOURCES,
    ...(input.metricSources ?? {}),
  };
  const metrics = Object.fromEntries(
    LIVE_LATENCY_BENCHMARK_METRIC_NAMES.map((metricName) => [
      metricName,
      summarizeMetric({
        samples: input.samples,
        metricName,
        source: metricSources[metricName],
      }),
    ]),
  ) as Record<
    LiveLatencyBenchmarkMetricName,
    LiveLatencyBenchmarkMetricSummary
  >;

  const firstVisibleP95 = metrics.acceptedToFirstVisibleMs.p95;
  return {
    concurrency: input.concurrency,
    sampleCount: input.samples.length,
    firstVisibleSloMs,
    passedFirstVisibleSlo:
      firstVisibleP95 !== null && firstVisibleP95 <= firstVisibleSloMs,
    metrics,
    measuredMetricNames: LIVE_LATENCY_BENCHMARK_METRIC_NAMES.filter(
      (metricName) => metricSources[metricName] === 'measured',
    ),
    syntheticMetricNames: LIVE_LATENCY_BENCHMARK_METRIC_NAMES.filter(
      (metricName) => metricSources[metricName] === 'synthetic',
    ),
    missingMetricNames: LIVE_LATENCY_BENCHMARK_METRIC_NAMES.filter(
      (metricName) => metrics[metricName].count === 0,
    ),
    deferredCount: input.deferredCount ?? 0,
    degradedCount: input.degradedCount ?? 0,
    failureCount: input.failureCount ?? 0,
  };
}

export async function writeLiveLatencyBenchmarkReportArtifact(
  input: WriteLiveLatencyBenchmarkReportArtifactInput,
): Promise<LiveLatencyBenchmarkReportArtifact> {
  const artifact: LiveLatencyBenchmarkReportArtifact = {
    schemaVersion: 1,
    benchmarkRunId: input.benchmarkRunId,
    generatedAt: input.generatedAt,
    report: input.report,
  };

  await fs.mkdir(path.dirname(input.artifactPath), { recursive: true });
  await fs.writeFile(
    input.artifactPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
  return artifact;
}

function metricLatency(
  latencies: Partial<Record<LiveLatencyBenchmarkMetricName, number>>,
  metricName: LiveLatencyBenchmarkMetricName,
): number {
  return normalizeMetricValue(latencies[metricName]) ?? 0;
}

function syntheticBeforeFirstVisibleMs(
  latencies: Partial<Record<LiveLatencyBenchmarkMetricName, number>>,
): number {
  return BEFORE_FIRST_VISIBLE_SYNTHETIC_METRICS.reduce(
    (total, metricName) => total + metricLatency(latencies, metricName),
    0,
  );
}

function defaultSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function sanitizeRunId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9:_-]/g, '-');
  return sanitized.length > 0 ? sanitized : 'live-latency-benchmark';
}

export function liveLatencyBenchmarkReportArtifactPath(
  input: LiveLatencyBenchmarkReportArtifactPathInput,
): string {
  return path.join(
    input.factoryDir ?? '.factory',
    'benchmarks',
    'live-latency',
    `${sanitizeRunId(input.benchmarkRunId)}.json`,
  );
}

export async function runSyntheticLiveLatencyBenchmark(
  input: SyntheticLiveLatencyBenchmarkInput,
): Promise<LiveLatencyBenchmarkReport> {
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  const workerCount = input.workerCount ?? DEFAULT_WORKER_COUNT;
  const claimBatchSize = input.claimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE;
  const claimTtlMs = input.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const nowMs = input.nowMs ?? Date.now;
  const sleepMs = input.sleepMs ?? defaultSleepMs;
  const runId = sanitizeRunId(
    input.benchmarkRunId ?? `live-latency-${process.pid}-${nowMs()}`,
  );
  const syntheticLatencies = input.syntheticLatenciesMs ?? {};
  const acceptedAtByItemId = new Map<string, number>();
  const samplesByItemId = new Map<string, LiveLatencyBenchmarkSample>();
  const measuredMetricCounts = new Map<
    LiveLatencyBenchmarkMetricName,
    number
  >();
  let failureCount = 0;
  let deferredCount = 0;
  let degradedCount = 0;

  function recordMeasuredMetric(
    metricName: LiveLatencyBenchmarkMetricName,
  ): void {
    measuredMetricCounts.set(
      metricName,
      (measuredMetricCounts.get(metricName) ?? 0) + 1,
    );
  }

  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const acceptedAtMs = nowMs();
      const itemId = `${runId}:admission:${index}`;
      const enqueueStartedAtMs = nowMs();
      const result = await input.liveAdmissions.enqueueLiveAdmissionWorkItem({
        id: itemId,
        appId: 'default',
        agentId: 'agent:live-latency-benchmark',
        agentSessionId: `session:${runId}:${index}`,
        conversationId: `app:live-latency-benchmark:${index}`,
        threadId: null,
        queueJid: `app:live-latency-benchmark:${index}`,
        messageId: `message:${runId}:${index}`,
        messageCursor: `${toIso(acceptedAtMs)}::${index}`,
        senderUserId: `user:${index}`,
        senderDisplayName: 'Synthetic User',
        idempotencyKey: `${runId}:delivery:${index}`,
        triggerDecision: {
          source: 'live_latency_benchmark',
          requiresTrigger: false,
        },
        now: toIso(acceptedAtMs),
      });
      const enqueueEndedAtMs = nowMs();
      acceptedAtByItemId.set(result.item.id, acceptedAtMs);
      samplesByItemId.set(result.item.id, {
        id: result.item.id,
        metrics: {
          dbPoolWaitMs: enqueueEndedAtMs - enqueueStartedAtMs,
          notifyLagMs: metricLatency(syntheticLatencies, 'notifyLagMs'),
        },
      });
    }),
  );

  let settledCount = 0;

  async function settleClaimedItem(inputItem: {
    id: string;
    claimToken: string | null;
    claimWorkerInstanceId: string | null;
    state: LiveAdmissionWorkItemState;
  }): Promise<void> {
    const sample = samplesByItemId.get(inputItem.id);
    const acceptedAtMs = acceptedAtByItemId.get(inputItem.id);
    if (!sample || acceptedAtMs === undefined) {
      failureCount += 1;
      return;
    }

    if (inputItem.state === 'deferred') deferredCount += 1;
    const syntheticStartupMs =
      syntheticBeforeFirstVisibleMs(syntheticLatencies);
    for (const metricName of LIVE_LATENCY_BENCHMARK_METRIC_NAMES) {
      if (
        metricName === 'acceptedToFirstVisibleMs' ||
        metricName === 'admissionLagMs' ||
        metricName === 'dbPoolWaitMs' ||
        metricName === 'lockWaitMs'
      ) {
        continue;
      }
      sample.metrics[metricName] = metricLatency(
        syntheticLatencies,
        metricName,
      );
    }

    const firstVisibleAtMs = nowMs() + syntheticStartupMs;
    sample.metrics.acceptedToFirstVisibleMs = firstVisibleAtMs - acceptedAtMs;
    sample.metrics.admissionLagMs = nowMs() - acceptedAtMs;
    const diagnostics = input.startupDiagnosticsByItemId?.get(inputItem.id);
    const measuredMetricsForSample = new Set<LiveLatencyBenchmarkMetricName>();
    for (const diagnostic of diagnostics ?? []) {
      const projection = startupDiagnosticToLiveLatencyMetrics(diagnostic, {
        acceptedToRunnerStartMs: sample.metrics.admissionLagMs,
      });
      Object.assign(sample.metrics, projection.metrics);
      for (const metricName of Object.keys(
        projection.metricSources,
      ) as LiveLatencyBenchmarkMetricName[]) {
        if (projection.metricSources[metricName] === 'measured') {
          measuredMetricsForSample.add(metricName);
        }
      }
    }
    for (const metricName of measuredMetricsForSample) {
      recordMeasuredMetric(metricName);
    }

    const settleStartedAtMs = nowMs();
    const settled = await input.liveAdmissions.settleLiveAdmissionWorkItem({
      id: inputItem.id,
      claimToken: inputItem.claimToken ?? '',
      workerInstanceId: inputItem.claimWorkerInstanceId ?? '',
      state: 'completed',
    });
    const settleEndedAtMs = nowMs();
    sample.metrics.dbPoolWaitMs =
      (sample.metrics.dbPoolWaitMs ?? 0) +
      (settleEndedAtMs - settleStartedAtMs);
    if (!settled) {
      failureCount += 1;
      return;
    }
    settledCount += 1;
  }

  async function worker(workerIndex: number): Promise<void> {
    while (settledCount + failureCount < concurrency) {
      const claimToken = `${runId}:worker:${workerIndex}:${nowMs()}`;
      const claimStartedAtMs = nowMs();
      const claimed = await input.liveAdmissions.claimLiveAdmissionWorkItems({
        workerInstanceId: `${runId}:worker:${workerIndex}`,
        claimToken,
        claimExpiresAt: toIso(nowMs() + claimTtlMs),
        limit: claimBatchSize,
      });
      const claimEndedAtMs = nowMs();
      if (claimed.length === 0) {
        if (settledCount + failureCount >= concurrency) return;
        await sleepMs(1);
        continue;
      }

      for (const item of claimed) {
        const sample = samplesByItemId.get(item.id);
        if (sample) {
          sample.metrics.lockWaitMs = claimEndedAtMs - claimStartedAtMs;
        }
        await settleClaimedItem(item);
      }
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => worker(index)),
  );

  const report = summarizeLiveLatencyBenchmark({
    concurrency,
    samples: [...samplesByItemId.values()],
    firstVisibleSloMs: input.firstVisibleSloMs,
    metricSources: Object.fromEntries(
      [...measuredMetricCounts.entries()]
        .filter(([, count]) => count === concurrency)
        .map(([metricName]) => [metricName, 'measured']),
    ),
    deferredCount,
    degradedCount,
    failureCount,
  });
  if (input.reportArtifactPath?.trim()) {
    await writeLiveLatencyBenchmarkReportArtifact({
      artifactPath: input.reportArtifactPath,
      benchmarkRunId: runId,
      generatedAt: toIso(nowMs()),
      report,
    });
  }
  return report;
}

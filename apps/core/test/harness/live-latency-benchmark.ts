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
] as const;

export type LiveLatencyBenchmarkMetricName =
  (typeof LIVE_LATENCY_BENCHMARK_METRIC_NAMES)[number];

export type LiveLatencyBenchmarkMetricSource = 'measured' | 'synthetic';

export const LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES = [
  'acceptedToFirstVisibleMs',
  'admissionLagMs',
  'poolCheckoutWaitMs',
  'queryElapsedMs',
  'transactionElapsedMs',
  'pgLockWaitMs',
  'liveAdmissionClaimMs',
  'mcpClientStartupMs',
  'toolListingFilteringMs',
  'permissionHitlSetupMs',
  'sandboxSpecMs',
  'sandboxStartMs',
  'modelConstructionMs',
] as const satisfies readonly LiveLatencyBenchmarkMetricName[];

export type LiveLatencyReadinessRequiredMetricName =
  (typeof LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES)[number];

export type LiveLatencyBenchmarkMetricEvidenceSource =
  | 'benchmark_observed'
  | 'pool_checkout_observed'
  | 'pg_lock_observed'
  | 'runtime_origin'
  | 'runner_origin'
  | 'fixture_seeded'
  | 'synthetic';

export type LiveLatencyBenchmarkMetricEvidenceSources = Partial<
  Record<
    LiveLatencyBenchmarkMetricName,
    LiveLatencyBenchmarkMetricEvidenceSource
  >
>;

export type LiveLatencyBenchmarkEvidenceSource =
  | 'real_live_runner'
  | 'synthetic_harness';

export type LiveLatencyBenchmarkMetricValues = Partial<
  Record<LiveLatencyBenchmarkMetricName, number>
>;

export interface LiveLatencyBenchmarkSample {
  id: string;
  metrics: LiveLatencyBenchmarkMetricValues;
  metricEvidenceSources?: LiveLatencyBenchmarkMetricEvidenceSources;
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
  benchmarkEvidenceSource: LiveLatencyBenchmarkEvidenceSource;
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
  backgroundClaimCount: number;
  readiness: LiveLatencyBenchmarkReadinessReport;
}

export type LiveLatencyBenchmarkReadinessFailureReason =
  | 'missing_metric'
  | 'synthetic_metric'
  | 'untrusted_evidence_source'
  | 'first_visible_slo_failed'
  | 'benchmark_deferred'
  | 'benchmark_degraded'
  | 'benchmark_failure'
  | 'synthetic_benchmark';

export interface LiveLatencyBenchmarkReadinessMetric {
  metricName: LiveLatencyReadinessRequiredMetricName;
  ready: boolean;
  source: LiveLatencyBenchmarkMetricSource;
  count: number;
  missing: number;
  evidenceSourceCounts: Partial<
    Record<LiveLatencyBenchmarkMetricEvidenceSource, number>
  >;
  allowedEvidenceSources: LiveLatencyBenchmarkMetricEvidenceSource[];
  failureReasons: LiveLatencyBenchmarkReadinessFailureReason[];
}

export interface LiveLatencyBenchmarkReadinessReport {
  passed: boolean;
  requiredMetricNames: LiveLatencyReadinessRequiredMetricName[];
  failedMetricNames: LiveLatencyReadinessRequiredMetricName[];
  failureReasons: LiveLatencyBenchmarkReadinessFailureReason[];
  metrics: Record<
    LiveLatencyReadinessRequiredMetricName,
    LiveLatencyBenchmarkReadinessMetric
  >;
  nonReadinessSyntheticMetricNames: LiveLatencyBenchmarkMetricName[];
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
  benchmarkEvidenceSource?: LiveLatencyBenchmarkEvidenceSource;
  firstVisibleSloMs?: number;
  metricSources?: Partial<
    Record<LiveLatencyBenchmarkMetricName, LiveLatencyBenchmarkMetricSource>
  >;
  deferredCount?: number;
  degradedCount?: number;
  failureCount?: number;
  backgroundClaimCount?: number;
}

export interface StartupDiagnosticToLiveLatencyMetricsOptions {
  acceptedToRunnerStartMs?: number;
}

interface StartupDiagnosticProjectionOptions extends StartupDiagnosticToLiveLatencyMetricsOptions {
  evidenceMode?: LiveLatencyStartupDiagnosticEvidenceMode;
}

export interface LiveLatencyBenchmarkDiagnosticProjection {
  metrics: LiveLatencyBenchmarkMetricValues;
  metricSources: Partial<
    Record<LiveLatencyBenchmarkMetricName, LiveLatencyBenchmarkMetricSource>
  >;
  metricEvidenceSources: LiveLatencyBenchmarkMetricEvidenceSources;
}

export interface LiveLatencyStartupDiagnosticsFromRuntimeEventsInput {
  runtimeEvents: RuntimeEventRepository;
  appId: string;
  itemRunIdsByItemId: ReadonlyMap<string, string>;
  afterEventId?: RuntimeEventId;
  pageLimit?: number;
  maxEvents?: number;
}

export type LiveLatencyStartupDiagnosticEvidenceMode =
  | 'fixture_seeded'
  | 'trusted_runtime_events';

const TRUSTED_STARTUP_DIAGNOSTIC = Symbol('trustedStartupDiagnostic');

export interface LiveLatencyStartupDiagnostic {
  payload: Record<string, unknown>;
  evidenceMode: 'trusted_runtime_events';
  [TRUSTED_STARTUP_DIAGNOSTIC]: true;
}

export type LiveLatencyStartupDiagnosticInput =
  | Record<string, unknown>
  | LiveLatencyStartupDiagnostic;

interface NormalizedStartupDiagnostic {
  payload: Record<string, unknown>;
  evidenceMode: LiveLatencyStartupDiagnosticEvidenceMode;
}

export interface LiveLatencyPostgresHotPathObserver {
  measurePoolCheckoutWaitMs(): Promise<number>;
  measurePgLockWaitMs(): Promise<number>;
}

export interface LiveLatencyPostgresHotPathPool {
  connect(): Promise<{ release(): void }>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    queryText: string,
  ): Promise<{ rows: T[] }>;
}

export interface LiveLatencyProviderSessionOperationInput {
  sampleId: string;
}

export interface LiveLatencyProviderSessionOperations {
  read(input: LiveLatencyProviderSessionOperationInput): Promise<void>;
  write(input: LiveLatencyProviderSessionOperationInput): Promise<void>;
}

export interface SyntheticLiveLatencyBenchmarkInput {
  liveAdmissions: LiveAdmissionWorkItemRepository;
  appId?: string;
  postgresHotPathObserver?: LiveLatencyPostgresHotPathObserver;
  providerSessionOperations?: LiveLatencyProviderSessionOperations;
  concurrency?: number;
  workerCount?: number;
  claimBatchSize?: number;
  claimTtlMs?: number;
  firstVisibleSloMs?: number;
  benchmarkRunId?: string;
  startupDiagnosticsByItemId?: ReadonlyMap<
    string,
    readonly LiveLatencyStartupDiagnosticInput[]
  >;
  maxBackgroundClaimCount?: number;
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
  providerSessionReadMs: 'synthetic',
  providerSessionWriteMs: 'synthetic',
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
  poolCheckoutWaitMs: 'synthetic',
  queryElapsedMs: 'measured',
  transactionElapsedMs: 'measured',
  pgLockWaitMs: 'synthetic',
  liveAdmissionClaimMs: 'measured',
  notifyLagMs: 'synthetic',
};

const LIVE_LATENCY_READINESS_ALLOWED_EVIDENCE_SOURCES: Record<
  LiveLatencyReadinessRequiredMetricName,
  readonly LiveLatencyBenchmarkMetricEvidenceSource[]
> = {
  acceptedToFirstVisibleMs: ['runner_origin'],
  admissionLagMs: ['benchmark_observed'],
  poolCheckoutWaitMs: ['pool_checkout_observed'],
  queryElapsedMs: ['benchmark_observed'],
  transactionElapsedMs: ['benchmark_observed'],
  pgLockWaitMs: ['pg_lock_observed'],
  liveAdmissionClaimMs: ['benchmark_observed'],
  mcpClientStartupMs: ['runner_origin'],
  toolListingFilteringMs: ['runtime_origin'],
  permissionHitlSetupMs: ['runner_origin'],
  sandboxSpecMs: ['runtime_origin'],
  sandboxStartMs: ['runner_origin'],
  modelConstructionMs: ['runner_origin'],
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
  evidenceSource: LiveLatencyBenchmarkMetricEvidenceSource,
): void {
  const normalized = normalizeMetricValue(value);
  if (normalized === undefined) return;
  projection.metrics[metricName] = normalized;
  projection.metricSources[metricName] = 'measured';
  projection.metricEvidenceSources[metricName] = evidenceSource;
}

function assignStartupDiagnosticMetric(
  projection: LiveLatencyBenchmarkDiagnosticProjection,
  metricName: LiveLatencyBenchmarkMetricName,
  value: unknown,
  evidenceSource: LiveLatencyBenchmarkMetricEvidenceSource = 'fixture_seeded',
): void {
  assignMeasuredMetric(projection, metricName, value, evidenceSource);
}

function startupDiagnosticEvidenceSource(
  metricName: LiveLatencyBenchmarkMetricName,
  mode: LiveLatencyStartupDiagnosticEvidenceMode | undefined,
): LiveLatencyBenchmarkMetricEvidenceSource {
  if (mode !== 'trusted_runtime_events') return 'fixture_seeded';
  return metricName === 'toolListingFilteringMs' ||
    metricName === 'sandboxTemplateMs' ||
    metricName === 'sandboxSpecMs'
    ? 'runtime_origin'
    : 'runner_origin';
}

function isTrustedStartupDiagnostic(
  input: LiveLatencyStartupDiagnosticInput,
): input is LiveLatencyStartupDiagnostic {
  return (
    (input as { [TRUSTED_STARTUP_DIAGNOSTIC]?: unknown })[
      TRUSTED_STARTUP_DIAGNOSTIC
    ] === true
  );
}

export function startupDiagnosticToLiveLatencyMetrics(
  payload: Record<string, unknown>,
  options: StartupDiagnosticToLiveLatencyMetricsOptions = {},
): LiveLatencyBenchmarkDiagnosticProjection {
  return projectStartupDiagnosticToLiveLatencyMetrics(payload, options);
}

function projectStartupDiagnosticToLiveLatencyMetrics(
  payload: Record<string, unknown>,
  options: StartupDiagnosticProjectionOptions = {},
): LiveLatencyBenchmarkDiagnosticProjection {
  const projection: LiveLatencyBenchmarkDiagnosticProjection = {
    metrics: {},
    metricSources: {},
    metricEvidenceSources: {},
  };
  const phases = readObject(payload.phases);
  const hostPhases = readObject(payload.hostPhases);
  const startupTiming = readObject(payload.startupTiming);
  const startupTimingHostPhases = readObject(startupTiming?.hostPhases);

  assignStartupDiagnosticMetric(
    projection,
    'checkpointLoadMs',
    payload.checkpointLoadMs,
    startupDiagnosticEvidenceSource('checkpointLoadMs', options.evidenceMode),
  );
  assignStartupDiagnosticMetric(
    projection,
    'checkpointWriteMs',
    payload.checkpointWriteMs,
    startupDiagnosticEvidenceSource('checkpointWriteMs', options.evidenceMode),
  );

  if (phases) {
    assignStartupDiagnosticMetric(
      projection,
      'modelConstructionMs',
      phases.modelBuildMs,
      startupDiagnosticEvidenceSource(
        'modelConstructionMs',
        options.evidenceMode,
      ),
    );
    assignStartupDiagnosticMetric(
      projection,
      'mcpClientStartupMs',
      phases.mcpConnectMs,
      startupDiagnosticEvidenceSource(
        'mcpClientStartupMs',
        options.evidenceMode,
      ),
    );
    assignStartupDiagnosticMetric(
      projection,
      'permissionHitlSetupMs',
      phases.permissionEnvMs,
      startupDiagnosticEvidenceSource(
        'permissionHitlSetupMs',
        options.evidenceMode,
      ),
    );
  }

  if (hostPhases) {
    assignStartupDiagnosticMetric(
      projection,
      'toolListingFilteringMs',
      hostPhases.mcpProjectionMs,
      startupDiagnosticEvidenceSource(
        'toolListingFilteringMs',
        options.evidenceMode,
      ),
    );
    assignStartupDiagnosticMetric(
      projection,
      'sandboxTemplateMs',
      hostPhases.sandboxTemplateMs,
      startupDiagnosticEvidenceSource(
        'sandboxTemplateMs',
        options.evidenceMode,
      ),
    );
    assignStartupDiagnosticMetric(
      projection,
      'sandboxSpecMs',
      hostPhases.sandboxSpecMs,
      startupDiagnosticEvidenceSource('sandboxSpecMs', options.evidenceMode),
    );
  }

  if (startupTiming) {
    assignStartupDiagnosticMetric(
      projection,
      'sandboxStartMs',
      startupTiming.sandboxStartCallMs,
      startupDiagnosticEvidenceSource('sandboxStartMs', options.evidenceMode),
    );
    assignStartupDiagnosticMetric(
      projection,
      'sandboxTemplateMs',
      startupTimingHostPhases?.sandboxTemplateMs,
      startupDiagnosticEvidenceSource(
        'sandboxTemplateMs',
        options.evidenceMode,
      ),
    );
    assignStartupDiagnosticMetric(
      projection,
      'sandboxSpecMs',
      startupTimingHostPhases?.sandboxSpecMs,
      startupDiagnosticEvidenceSource('sandboxSpecMs', options.evidenceMode),
    );
    assignStartupDiagnosticMetric(
      projection,
      'toolListingFilteringMs',
      startupTimingHostPhases?.mcpProjectionMs,
      startupDiagnosticEvidenceSource(
        'toolListingFilteringMs',
        options.evidenceMode,
      ),
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
    assignStartupDiagnosticMetric(
      projection,
      'acceptedToFirstVisibleMs',
      acceptedToRunnerStartMs + runnerFirstVisibleMs,
      startupDiagnosticEvidenceSource(
        'acceptedToFirstVisibleMs',
        options.evidenceMode,
      ),
    );
  }

  return projection;
}

function normalizeStartupDiagnosticInput(
  input: LiveLatencyStartupDiagnosticInput,
): NormalizedStartupDiagnostic {
  if (isTrustedStartupDiagnostic(input)) {
    return {
      payload: input.payload,
      evidenceMode: input.evidenceMode,
    };
  }
  return {
    payload: input as Record<string, unknown>,
    evidenceMode: 'fixture_seeded',
  };
}

function trustedRuntimeEventStartupDiagnostic(
  payload: Record<string, unknown>,
): LiveLatencyStartupDiagnostic {
  return {
    payload,
    evidenceMode: 'trusted_runtime_events',
    [TRUSTED_STARTUP_DIAGNOSTIC]: true,
  };
}

export async function loadLiveLatencyStartupDiagnosticsFromRuntimeEvents(
  input: LiveLatencyStartupDiagnosticsFromRuntimeEventsInput,
): Promise<Map<string, readonly LiveLatencyStartupDiagnostic[]>> {
  const expectedRunIds = new Set(
    [...input.itemRunIdsByItemId.values()]
      .map((runId) => runId.trim())
      .filter((runId) => runId.length > 0),
  );
  const diagnosticsByRunId = new Map<string, LiveLatencyStartupDiagnostic[]>();
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
      diagnostics.push(trustedRuntimeEventStartupDiagnostic(payload));
      diagnosticsByRunId.set(runId, diagnostics);
    }
    if (events.length < limit) break;
  }

  const diagnosticsByItemId = new Map<
    string,
    readonly LiveLatencyStartupDiagnostic[]
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

function countMetricEvidenceSources(input: {
  samples: LiveLatencyBenchmarkSample[];
  metricName: LiveLatencyBenchmarkMetricName;
}): Partial<Record<LiveLatencyBenchmarkMetricEvidenceSource, number>> {
  const counts: Partial<
    Record<LiveLatencyBenchmarkMetricEvidenceSource, number>
  > = {};
  for (const sample of input.samples) {
    const source = sample.metricEvidenceSources?.[input.metricName];
    if (!source) continue;
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

function readinessMetricHasTrustedEvidence(input: {
  samples: LiveLatencyBenchmarkSample[];
  metricName: LiveLatencyReadinessRequiredMetricName;
}): boolean {
  if (input.samples.length === 0) return false;
  const allowedEvidenceSources =
    LIVE_LATENCY_READINESS_ALLOWED_EVIDENCE_SOURCES[input.metricName];
  return input.samples.every((sample) => {
    const value = normalizeMetricValue(sample.metrics[input.metricName]);
    if (value === undefined) return false;
    const evidenceSource = sample.metricEvidenceSources?.[input.metricName];
    return (
      evidenceSource !== undefined &&
      allowedEvidenceSources.includes(evidenceSource)
    );
  });
}

function effectiveMetricSources(input: {
  samples: LiveLatencyBenchmarkSample[];
  metricSources: Record<
    LiveLatencyBenchmarkMetricName,
    LiveLatencyBenchmarkMetricSource
  >;
}): Record<LiveLatencyBenchmarkMetricName, LiveLatencyBenchmarkMetricSource> {
  const sources = { ...input.metricSources };
  for (const metricName of LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES) {
    if (
      sources[metricName] === 'measured' &&
      !readinessMetricHasTrustedEvidence({
        samples: input.samples,
        metricName,
      })
    ) {
      sources[metricName] = 'synthetic';
    }
  }
  return sources;
}

function readinessFailureReasons(input: {
  summary: LiveLatencyBenchmarkMetricSummary;
  evidenceSourceCounts: Partial<
    Record<LiveLatencyBenchmarkMetricEvidenceSource, number>
  >;
  sampleCount: number;
  allowedEvidenceSources: readonly LiveLatencyBenchmarkMetricEvidenceSource[];
}): LiveLatencyBenchmarkReadinessFailureReason[] {
  const reasons: LiveLatencyBenchmarkReadinessFailureReason[] = [];
  if (input.summary.count !== input.sampleCount || input.summary.missing > 0) {
    reasons.push('missing_metric');
  }
  if (input.summary.source !== 'measured') {
    reasons.push('synthetic_metric');
  }
  const allowedCount = input.allowedEvidenceSources.reduce(
    (total, source) => total + (input.evidenceSourceCounts[source] ?? 0),
    0,
  );
  if (allowedCount !== input.sampleCount) {
    reasons.push('untrusted_evidence_source');
  }
  return reasons;
}

function uniqueReasons(
  reasons: LiveLatencyBenchmarkReadinessFailureReason[],
): LiveLatencyBenchmarkReadinessFailureReason[] {
  return [...new Set(reasons)];
}

function summarizeReadiness(input: {
  samples: LiveLatencyBenchmarkSample[];
  benchmarkEvidenceSource: LiveLatencyBenchmarkEvidenceSource;
  metrics: Record<
    LiveLatencyBenchmarkMetricName,
    LiveLatencyBenchmarkMetricSummary
  >;
  syntheticMetricNames: LiveLatencyBenchmarkMetricName[];
  passedFirstVisibleSlo: boolean;
  deferredCount: number;
  degradedCount: number;
  failureCount: number;
}): LiveLatencyBenchmarkReadinessReport {
  const metricEntries = LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES.map(
    (
      metricName,
    ): [
      LiveLatencyReadinessRequiredMetricName,
      LiveLatencyBenchmarkReadinessMetric,
    ] => {
      const summary = input.metrics[metricName];
      const allowedEvidenceSources =
        LIVE_LATENCY_READINESS_ALLOWED_EVIDENCE_SOURCES[metricName];
      const evidenceSourceCounts = countMetricEvidenceSources({
        samples: input.samples,
        metricName,
      });
      const failureReasons = readinessFailureReasons({
        summary,
        evidenceSourceCounts,
        sampleCount: input.samples.length,
        allowedEvidenceSources,
      });
      return [
        metricName,
        {
          metricName,
          ready: failureReasons.length === 0,
          source: summary.source,
          count: summary.count,
          missing: summary.missing,
          evidenceSourceCounts,
          allowedEvidenceSources: [...allowedEvidenceSources],
          failureReasons,
        },
      ];
    },
  );
  const metrics = Object.fromEntries(metricEntries) as Record<
    LiveLatencyReadinessRequiredMetricName,
    LiveLatencyBenchmarkReadinessMetric
  >;
  const failedMetricNames = LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES.filter(
    (metricName) => !metrics[metricName].ready,
  );
  const globalFailureReasons: LiveLatencyBenchmarkReadinessFailureReason[] = [];
  if (!input.passedFirstVisibleSlo) {
    globalFailureReasons.push('first_visible_slo_failed');
  }
  if (input.deferredCount > 0) globalFailureReasons.push('benchmark_deferred');
  if (input.degradedCount > 0) globalFailureReasons.push('benchmark_degraded');
  if (input.failureCount > 0) globalFailureReasons.push('benchmark_failure');
  if (input.benchmarkEvidenceSource !== 'real_live_runner') {
    globalFailureReasons.push('synthetic_benchmark');
  }

  return {
    passed: failedMetricNames.length === 0 && globalFailureReasons.length === 0,
    requiredMetricNames: [...LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES],
    failedMetricNames,
    failureReasons: uniqueReasons([
      ...globalFailureReasons,
      ...Object.values(metrics).flatMap((metric) => metric.failureReasons),
    ]),
    metrics,
    nonReadinessSyntheticMetricNames: input.syntheticMetricNames.filter(
      (metricName) =>
        !LIVE_LATENCY_READINESS_REQUIRED_METRIC_NAMES.includes(
          metricName as LiveLatencyReadinessRequiredMetricName,
        ),
    ),
  };
}

export function summarizeLiveLatencyBenchmark(
  input: LiveLatencyBenchmarkSummaryInput,
): LiveLatencyBenchmarkReport {
  const firstVisibleSloMs =
    input.firstVisibleSloMs ?? DEFAULT_FIRST_VISIBLE_SLO_MS;
  const benchmarkEvidenceSource =
    input.benchmarkEvidenceSource ?? 'real_live_runner';
  const metricSources = {
    ...DEFAULT_METRIC_SOURCES,
    ...(input.metricSources ?? {}),
  };
  const reportMetricSources = effectiveMetricSources({
    samples: input.samples,
    metricSources,
  });
  const metrics = Object.fromEntries(
    LIVE_LATENCY_BENCHMARK_METRIC_NAMES.map((metricName) => [
      metricName,
      summarizeMetric({
        samples: input.samples,
        metricName,
        source: reportMetricSources[metricName],
      }),
    ]),
  ) as Record<
    LiveLatencyBenchmarkMetricName,
    LiveLatencyBenchmarkMetricSummary
  >;

  const firstVisibleP95 = metrics.acceptedToFirstVisibleMs.p95;
  const passedFirstVisibleSlo =
    firstVisibleP95 !== null && firstVisibleP95 <= firstVisibleSloMs;
  const measuredMetricNames = LIVE_LATENCY_BENCHMARK_METRIC_NAMES.filter(
    (metricName) => reportMetricSources[metricName] === 'measured',
  );
  const syntheticMetricNames = LIVE_LATENCY_BENCHMARK_METRIC_NAMES.filter(
    (metricName) => reportMetricSources[metricName] === 'synthetic',
  );
  const missingMetricNames = LIVE_LATENCY_BENCHMARK_METRIC_NAMES.filter(
    (metricName) => metrics[metricName].count === 0,
  );
  const deferredCount = input.deferredCount ?? 0;
  const degradedCount = input.degradedCount ?? 0;
  const failureCount = input.failureCount ?? 0;
  const backgroundClaimCount = input.backgroundClaimCount ?? 0;
  return {
    concurrency: input.concurrency,
    sampleCount: input.samples.length,
    benchmarkEvidenceSource,
    firstVisibleSloMs,
    passedFirstVisibleSlo,
    metrics,
    measuredMetricNames,
    syntheticMetricNames,
    missingMetricNames,
    deferredCount,
    degradedCount,
    failureCount,
    backgroundClaimCount,
    readiness: summarizeReadiness({
      samples: input.samples,
      benchmarkEvidenceSource,
      metrics,
      syntheticMetricNames,
      passedFirstVisibleSlo,
      deferredCount,
      degradedCount,
      failureCount,
    }),
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

export function createPostgresLiveLatencyHotPathObserver(
  pool: LiveLatencyPostgresHotPathPool,
  nowMs: () => number = Date.now,
): LiveLatencyPostgresHotPathObserver {
  return {
    async measurePoolCheckoutWaitMs(): Promise<number> {
      const startedAtMs = nowMs();
      const client = await pool.connect();
      try {
        return nowMs() - startedAtMs;
      } finally {
        client.release();
      }
    },
    async measurePgLockWaitMs(): Promise<number> {
      const result = await pool.query<{ max_lock_wait_ms: number | string }>(
        `SELECT COALESCE(
           MAX(EXTRACT(EPOCH FROM (clock_timestamp() - locks.waitstart)) * 1000),
           0
         )::float AS max_lock_wait_ms
         FROM pg_stat_activity AS activity
         JOIN pg_locks AS locks ON locks.pid = activity.pid
         WHERE activity.datname = current_database()
           AND activity.wait_event_type = 'Lock'
           AND activity.pid <> pg_backend_pid()
           AND NOT locks.granted
           AND locks.waitstart IS NOT NULL`,
      );
      return (
        normalizeMetricValue(Number(result.rows[0]?.max_lock_wait_ms)) ?? 0
      );
    },
  };
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
  const appId = input.appId ?? 'default';
  const syntheticLatencies = input.syntheticLatenciesMs ?? {};
  const acceptedAtByItemId = new Map<string, number>();
  const samplesByItemId = new Map<string, LiveLatencyBenchmarkSample>();
  const measuredMetricCounts = new Map<
    LiveLatencyBenchmarkMetricName,
    number
  >();
  const maxBackgroundClaimCount = input.maxBackgroundClaimCount ?? 0;
  let failureCount = 0;
  let deferredCount = 0;
  let degradedCount = 0;
  let backgroundClaimCount = 0;

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
        appId,
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
          queryElapsedMs: enqueueEndedAtMs - enqueueStartedAtMs,
          notifyLagMs: metricLatency(syntheticLatencies, 'notifyLagMs'),
        },
        metricEvidenceSources: {
          queryElapsedMs: 'benchmark_observed',
          notifyLagMs: 'synthetic',
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
      backgroundClaimCount += 1;
      if (backgroundClaimCount > maxBackgroundClaimCount) failureCount += 1;
      return;
    }

    if (inputItem.state === 'deferred') deferredCount += 1;
    const syntheticStartupMs =
      syntheticBeforeFirstVisibleMs(syntheticLatencies);
    for (const metricName of LIVE_LATENCY_BENCHMARK_METRIC_NAMES) {
      if (
        metricName === 'acceptedToFirstVisibleMs' ||
        metricName === 'admissionLagMs' ||
        metricName === 'poolCheckoutWaitMs' ||
        metricName === 'queryElapsedMs' ||
        metricName === 'transactionElapsedMs' ||
        metricName === 'pgLockWaitMs' ||
        metricName === 'liveAdmissionClaimMs'
      ) {
        continue;
      }
      sample.metrics[metricName] = metricLatency(
        syntheticLatencies,
        metricName,
      );
      sample.metricEvidenceSources ??= {};
      sample.metricEvidenceSources[metricName] = 'synthetic';
    }

    if (input.providerSessionOperations) {
      const readStartedAtMs = nowMs();
      await input.providerSessionOperations.read({ sampleId: inputItem.id });
      sample.metrics.providerSessionReadMs = nowMs() - readStartedAtMs;
      sample.metricEvidenceSources.providerSessionReadMs = 'benchmark_observed';
      recordMeasuredMetric('providerSessionReadMs');

      const writeStartedAtMs = nowMs();
      await input.providerSessionOperations.write({ sampleId: inputItem.id });
      sample.metrics.providerSessionWriteMs = nowMs() - writeStartedAtMs;
      sample.metricEvidenceSources.providerSessionWriteMs =
        'benchmark_observed';
      recordMeasuredMetric('providerSessionWriteMs');
    }

    const firstVisibleAtMs = nowMs() + syntheticStartupMs;
    sample.metrics.acceptedToFirstVisibleMs = firstVisibleAtMs - acceptedAtMs;
    sample.metrics.admissionLagMs = nowMs() - acceptedAtMs;
    sample.metricEvidenceSources ??= {};
    sample.metricEvidenceSources.acceptedToFirstVisibleMs = 'synthetic';
    sample.metricEvidenceSources.admissionLagMs = 'benchmark_observed';
    const diagnostics = input.startupDiagnosticsByItemId?.get(inputItem.id);
    const measuredMetricsForSample = new Set<LiveLatencyBenchmarkMetricName>();
    for (const diagnosticInput of diagnostics ?? []) {
      const diagnostic = normalizeStartupDiagnosticInput(diagnosticInput);
      const projection = projectStartupDiagnosticToLiveLatencyMetrics(
        diagnostic.payload,
        {
          acceptedToRunnerStartMs: sample.metrics.admissionLagMs,
          evidenceMode: diagnostic.evidenceMode,
        },
      );
      Object.assign(sample.metrics, projection.metrics);
      sample.metricEvidenceSources = {
        ...(sample.metricEvidenceSources ?? {}),
        ...projection.metricEvidenceSources,
      };
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
    sample.metrics.queryElapsedMs =
      (sample.metrics.queryElapsedMs ?? 0) +
      (settleEndedAtMs - settleStartedAtMs);
    sample.metricEvidenceSources.queryElapsedMs = 'benchmark_observed';
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
        appId,
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
          const observedPoolCheckoutWaitMs =
            await input.postgresHotPathObserver?.measurePoolCheckoutWaitMs();
          const observedPgLockWaitMs =
            await input.postgresHotPathObserver?.measurePgLockWaitMs();
          sample.metrics.liveAdmissionClaimMs =
            claimEndedAtMs - claimStartedAtMs;
          sample.metrics.transactionElapsedMs =
            claimEndedAtMs - claimStartedAtMs;
          if (observedPoolCheckoutWaitMs !== undefined) {
            sample.metrics.poolCheckoutWaitMs = observedPoolCheckoutWaitMs;
          }
          if (observedPgLockWaitMs !== undefined) {
            sample.metrics.pgLockWaitMs = observedPgLockWaitMs;
          }
          sample.metricEvidenceSources ??= {};
          sample.metricEvidenceSources.liveAdmissionClaimMs =
            'benchmark_observed';
          sample.metricEvidenceSources.transactionElapsedMs =
            'benchmark_observed';
          if (observedPoolCheckoutWaitMs !== undefined) {
            sample.metricEvidenceSources.poolCheckoutWaitMs =
              'pool_checkout_observed';
            recordMeasuredMetric('poolCheckoutWaitMs');
          }
          if (observedPgLockWaitMs !== undefined) {
            sample.metricEvidenceSources.pgLockWaitMs = 'pg_lock_observed';
            recordMeasuredMetric('pgLockWaitMs');
          }
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
    benchmarkEvidenceSource: 'synthetic_harness',
    firstVisibleSloMs: input.firstVisibleSloMs,
    metricSources: Object.fromEntries(
      [...measuredMetricCounts.entries()]
        .filter(([, count]) => count === concurrency)
        .map(([metricName]) => [metricName, 'measured']),
    ),
    deferredCount,
    degradedCount,
    failureCount,
    backgroundClaimCount,
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

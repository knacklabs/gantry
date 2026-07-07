import type { Job } from '../domain/types.js';

export const REMOTE_HOST_TASK_EXECUTORS_ENV =
  'GANTRY_REMOTE_HOST_TASK_EXECUTORS_JSON';

export interface HostTaskTarget {
  kind: 'host_task';
  executorId: string;
  inputRef: string;
}

export interface HostTaskExecutionInput {
  job: Job;
  runId: string;
  leaseToken: string;
  fencingVersion: number;
  workerInstanceId: string;
  target: HostTaskTarget;
  signal: AbortSignal;
  emitProgress: (payload: Record<string, unknown>) => Promise<void>;
}

export interface HostTaskExecutionResult {
  resultSummary?: string | null;
}

export type HostTaskExecutor = (
  input: HostTaskExecutionInput,
) => Promise<HostTaskExecutionResult | void>;

interface RemoteHostTaskExecutorConfig {
  executorId: string;
  endpointUrl: string;
  authToken?: string | null;
  timeoutMs?: number | null;
}

const executors = new Map<string, HostTaskExecutor>();
let envRemoteExecutorsRegistered = false;

export function registerHostTaskExecutor(
  executorId: string,
  executor: HostTaskExecutor,
): () => void {
  const normalized = normalizeOpaqueId(executorId, 'executorId');
  executors.set(normalized, executor);
  return () => {
    if (executors.get(normalized) === executor) executors.delete(normalized);
  };
}

export function getHostTaskExecutor(
  executorId: string,
): HostTaskExecutor | undefined {
  ensureRemoteHostTaskExecutorsFromEnv();
  return executors.get(normalizeOpaqueId(executorId, 'executorId'));
}

export function hostTaskCapabilityId(executorId: string): string {
  return `host_task:${normalizeOpaqueId(executorId, 'executorId')}`;
}

export function configuredRemoteHostTaskCapabilityIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return parseRemoteHostTaskExecutorConfigs(env)
    .map((config) => hostTaskCapabilityId(config.executorId))
    .sort();
}

export function parseHostTaskTarget(input: unknown): HostTaskTarget | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.kind !== 'host_task') return null;
  const executorId =
    typeof record.executorId === 'string' ? record.executorId.trim() : '';
  const inputRef =
    typeof record.inputRef === 'string' ? record.inputRef.trim() : '';
  if (!executorId || !inputRef) return null;
  return {
    kind: 'host_task',
    executorId: normalizeOpaqueId(executorId, 'executorId'),
    inputRef: normalizeOpaqueId(inputRef, 'inputRef'),
  };
}

export function ensureRemoteHostTaskExecutorsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): void {
  if (envRemoteExecutorsRegistered) return;
  envRemoteExecutorsRegistered = true;
  for (const config of parseRemoteHostTaskExecutorConfigs(env)) {
    registerHostTaskExecutor(
      config.executorId,
      createRemoteHostTaskExecutor(config, fetchImpl),
    );
  }
}

function createRemoteHostTaskExecutor(
  config: RemoteHostTaskExecutorConfig,
  fetchImpl: typeof fetch,
): HostTaskExecutor {
  const endpointUrl = normalizeEndpointUrl(config.endpointUrl);
  const timeoutMs =
    typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)
      ? Math.max(1_000, Math.floor(config.timeoutMs))
      : 60_000;
  const authToken = normalizeOptionalString(config.authToken);
  return async (input) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    const response = await fetchImpl(endpointUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        jobId: input.job.id,
        runId: input.runId,
        leaseToken: input.leaseToken,
        fencingVersion: input.fencingVersion,
        workerInstanceId: input.workerInstanceId,
        target: input.target,
      }),
      signal,
    });
    const text = await response.text();
    const payload = text ? parseJsonObject(text) : {};
    if (!response.ok) {
      const message =
        readString(payload.error) ??
        readString(payload.message) ??
        text.slice(0, 500) ??
        'remote_host_task_failed';
      throw new Error(
        `Remote host task executor ${input.target.executorId} failed (${response.status}): ${message}`,
      );
    }
    return {
      resultSummary: readString(payload.resultSummary),
    };
  };
}

function parseRemoteHostTaskExecutorConfigs(
  env: NodeJS.ProcessEnv,
): RemoteHostTaskExecutorConfig[] {
  const raw = env[REMOTE_HOST_TASK_EXECUTORS_ENV]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const configs: RemoteHostTaskExecutorConfig[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const executorId = readString(record.executorId);
    const endpointUrl = readString(record.endpointUrl);
    if (!executorId || !endpointUrl) continue;
    configs.push({
      executorId: normalizeOpaqueId(executorId, 'executorId'),
      endpointUrl,
      authToken: readString(record.authToken),
      timeoutMs:
        typeof record.timeoutMs === 'number' &&
        Number.isFinite(record.timeoutMs)
          ? record.timeoutMs
          : null,
    });
  }
  return configs;
}

function normalizeOpaqueId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(trimmed)) {
    throw new Error(`${field} must be an opaque identifier.`);
  }
  return trimmed;
}

function normalizeEndpointUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//u.test(trimmed)) {
    throw new Error('remote host task endpointUrl must be an HTTP(S) URL.');
  }
  return trimmed;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeOptionalString(value: unknown): string | null {
  return readString(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

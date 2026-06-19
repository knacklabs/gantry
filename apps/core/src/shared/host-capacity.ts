import { availableParallelism, cpus, hostname } from 'node:os';

export const HOST_EXECUTION_SLOT_KEY_PREFIX = 'host:execution:';

type HostCapacityProcessRole = 'all' | 'control' | 'live-worker' | 'job-worker';
export type HostExecutionRuntimeClass = 'interactive' | 'background';

interface HostCapacityQueueOptions {
  maxMessageRuns?: number;
  maxJobRuns?: number;
}

export interface HostCapacityPlan {
  cpuThreads: number;
  budget: number;
  interactiveCapacity: number;
  backgroundCapacity: number;
}

export function detectHostCpuThreads(): number {
  return Math.max(1, Math.floor(availableParallelism?.() ?? cpus().length));
}

export function hostExecutionSlotKey(
  workerInstanceId?: string,
  runtimeClass?: HostExecutionRuntimeClass,
): string {
  const baseKey = `${HOST_EXECUTION_SLOT_KEY_PREFIX}${hostExecutionIdentity(workerInstanceId)}`;
  return runtimeClass ? `${baseKey}:${runtimeClass}` : baseKey;
}

export function hostExecutionSlotHolderId(holderId: string): string {
  return `host:${holderId}`;
}

export function computeHostCapacityPlan(input: {
  queue: HostCapacityQueueOptions;
  processRole?: HostCapacityProcessRole;
  cpuThreads?: number;
}): HostCapacityPlan {
  const role = input.processRole ?? 'all';
  const cpuThreads = Math.max(
    1,
    Math.floor(input.cpuThreads ?? detectHostCpuThreads()),
  );
  const desiredInteractive = normalizeNonNegative(
    input.queue.maxMessageRuns,
    3,
  );
  const desiredBackground = normalizeNonNegative(input.queue.maxJobRuns, 4);
  const runsInteractive = role === 'all' || role === 'live-worker';
  const runsBackground = role === 'all' || role === 'job-worker';
  const splitInteractiveBudget =
    role === 'live-worker'
      ? Math.max(1, Math.ceil(cpuThreads / 2))
      : cpuThreads;
  const backgroundFloor =
    role === 'all' && desiredBackground > 0 && cpuThreads > 1 ? 1 : 0;
  const interactiveCapacity = runsInteractive
    ? Math.min(desiredInteractive, splitInteractiveBudget - backgroundFloor)
    : 0;
  const reservedInteractiveBudget =
    role === 'job-worker' && hasExplicitHostExecutionIdentity()
      ? Math.min(desiredInteractive, cpuThreads)
      : 0;
  const backgroundBudget =
    runsInteractive && runsBackground
      ? cpuThreads - interactiveCapacity
      : cpuThreads - reservedInteractiveBudget;
  const backgroundCapacity = runsBackground
    ? Math.min(desiredBackground, backgroundBudget)
    : 0;

  return {
    cpuThreads,
    budget: cpuThreads,
    interactiveCapacity,
    backgroundCapacity,
  };
}

export function applyHostCapacityToQueuePolicy(
  queue: HostCapacityQueueOptions,
  processRole?: HostCapacityProcessRole,
  cpuThreads?: number,
): HostCapacityQueueOptions {
  const plan = computeHostCapacityPlan({ queue, processRole, cpuThreads });
  return {
    ...queue,
    maxMessageRuns:
      plan.interactiveCapacity > 0
        ? plan.interactiveCapacity
        : queue.maxMessageRuns,
    maxJobRuns: plan.backgroundCapacity,
  };
}

function normalizeNonNegative(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function hasExplicitHostExecutionIdentity(): boolean {
  return Boolean(process.env.GANTRY_HOST_ID?.trim());
}

function hostExecutionIdentity(workerInstanceId?: string): string {
  return (
    process.env.GANTRY_HOST_ID?.trim() ||
    (workerInstanceId?.trim() ? `worker:${workerInstanceId.trim()}` : '') ||
    hostname().trim() ||
    'local'
  ).replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

import type { Job, JobRun } from '../domain/types.js';

export interface JobRuntimeBudget {
  configuredRunTimeoutMs: number;
  totalTimeoutMs: number | null;
  consumedMs: number;
  remainingMs: number | null;
  exhausted: boolean;
  runTimeoutMs: number;
}

export function resolveJobRuntimeBudget(input: {
  job: Job;
  priorRuns: readonly JobRun[];
}): JobRuntimeBudget {
  const configuredRunTimeoutMs = Math.max(
    30_000,
    input.job.timeout_ms || 300_000,
  );
  const configuredTotal = input.job.agent_task?.executionPolicy.totalTimeoutMs;
  const totalTimeoutMs =
    Number.isSafeInteger(configuredTotal) && Number(configuredTotal) > 0
      ? Number(configuredTotal)
      : null;
  const consumedMs =
    totalTimeoutMs === null
      ? 0
      : input.priorRuns.reduce((total, run) => {
          if (!run.ended_at) return total;
          const startedAt = Date.parse(run.started_at);
          const endedAt = Date.parse(run.ended_at);
          return Number.isFinite(startedAt) && Number.isFinite(endedAt)
            ? total + Math.max(0, endedAt - startedAt)
            : total;
        }, 0);
  const remainingMs =
    totalTimeoutMs === null ? null : Math.max(0, totalTimeoutMs - consumedMs);
  return {
    configuredRunTimeoutMs,
    totalTimeoutMs,
    consumedMs,
    remainingMs,
    exhausted: remainingMs === 0,
    runTimeoutMs:
      remainingMs === null
        ? configuredRunTimeoutMs
        : Math.max(1, Math.min(configuredRunTimeoutMs, remainingMs)),
  };
}

export function appendRuntimeBudgetContext(
  prompt: string,
  budget: JobRuntimeBudget,
): string {
  if (budget.totalTimeoutMs === null) return prompt;
  return `${prompt}\n\nGANTRY_RUNTIME_BUDGET\n${JSON.stringify({
    totalTimeoutMs: budget.totalTimeoutMs,
    consumedBeforeRunMs: budget.consumedMs,
    remainingForRunMs: budget.remainingMs,
  })}\nTreat this host-derived cumulative budget as authoritative. Before it expires, save a runtime-boundary checkpoint and return the contract's incomplete terminal outcome with explicit reasoning.`;
}

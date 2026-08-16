import { describe, expect, it } from 'vitest';

import type { Job, JobRun } from '@core/domain/types.js';
import {
  appendRuntimeBudgetContext,
  resolveJobRuntimeBudget,
} from '@core/jobs/execution-runtime-budget.js';

const job = {
  timeout_ms: 7_200_000,
  agent_task: { executionPolicy: { totalTimeoutMs: 7_200_000 } },
} as Job;

function run(startedAt: string, endedAt: string | null): JobRun {
  return { started_at: startedAt, ended_at: endedAt } as JobRun;
}

describe('resolveJobRuntimeBudget', () => {
  it('subtracts only durable completed run time and caps the continuation', () => {
    const budget = resolveJobRuntimeBudget({
      job,
      priorRuns: [
        run('2026-08-13T00:00:00.000Z', '2026-08-13T01:00:00.000Z'),
        run('2026-08-13T01:00:00.000Z', '2026-08-13T01:30:00.000Z'),
        run('2026-08-13T02:00:00.000Z', null),
      ],
    });

    expect(budget).toMatchObject({
      consumedMs: 5_400_000,
      remainingMs: 1_800_000,
      runTimeoutMs: 1_800_000,
      exhausted: false,
    });
    expect(appendRuntimeBudgetContext('goal', budget)).toContain(
      '"remainingForRunMs":1800000',
    );
  });

  it('fences a continuation after the cumulative budget is consumed', () => {
    expect(
      resolveJobRuntimeBudget({
        job,
        priorRuns: [
          run('2026-08-13T00:00:00.000Z', '2026-08-13T02:00:01.000Z'),
        ],
      }),
    ).toMatchObject({ remainingMs: 0, runTimeoutMs: 1, exhausted: true });
  });
});

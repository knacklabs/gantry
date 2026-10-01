import { expect, it } from 'vitest';

import { initialCard } from '@core/application/interactions/job-permission-card-projection.js';
import { pruneSettledCardHistory } from '@core/domain/job-permission-card-history.js';

it('keeps wait budgets only for waiting runs and the newest twenty resumed runs', () => {
  const card = initialCard(
    { appId: 'app', jobId: 'job', conversationId: 'conversation' },
    '2026-10-01T00:00:00.000Z',
  );
  for (let run = 1; run <= 60; run += 1) {
    card.pendingBudgets.push({
      runId: `run-${run}`,
      openCount: run === 1 ? 1 : 0,
      accumulatedMs: run % 2 === 0 ? 1_000 : 0,
      hostBootId: 'boot',
      lastMonotonicMs: run,
    });
  }

  pruneSettledCardHistory(card);

  expect(card.pendingBudgets.map(({ runId }) => runId)).toEqual([
    'run-1',
    ...Array.from({ length: 20 }, (_, index) => `run-${22 + index * 2}`),
  ]);
});

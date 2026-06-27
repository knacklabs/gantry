import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectAndUpsertPatternCandidates } from '@core/memory/app-memory-item-queries.js';
import { loadPatternsContext } from '@core/shared/pattern-candidate-block.js';
import {
  patternSubjectForScope,
  type PatternSubjectScope,
  type PatternSubjectTuple,
} from '@core/shared/pattern-candidate-subject.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// Proves the atomic surfacing claim: two parallel runs that read the same
// `detected` candidate cannot both surface it. Skipped unless
// GANTRY_TEST_DATABASE_URL is set.
const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'pattern_claim_app';
const SCOPE: PatternSubjectScope = {
  appId: APP_ID,
  agentId: 'pattern_claim_agent',
  folder: 'pattern-claim-folder',
  conversationKind: 'channel',
  conversationId: 'sl:CCLAIM',
};
const OUTCOME = 'summarize the weekly report for claim race';
const WINDOW_START = '2026-06-01T00:00:00.000Z';
const WINDOW_END = '2026-06-07T00:00:00.000Z';
const NOW_ISO = '2026-06-08T00:00:00.000Z';

maybeDescribe('pattern candidate atomic surfacing claim', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'pattern_claim',
    });
    const now = new Date().toISOString();
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: APP_ID,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('lets only one of two parallel runs surface the same detected candidate', async () => {
    const subject = patternSubjectForScope(SCOPE) as PatternSubjectTuple;
    await expect(
      detectAndUpsertPatternCandidates({
        db: runtime.service.db,
        subject: { ...subject },
        // >= PATTERN_VALUE_FLOOR_MIN_OCCURRENCES (4) so the candidate is eligible.
        transcriptTurns: [
          { intent: OUTCOME, messageId: 'claim-m1' },
          { intent: OUTCOME, messageId: 'claim-m2' },
          { intent: OUTCOME, messageId: 'claim-m3' },
          { intent: OUTCOME, messageId: 'claim-m4' },
        ],
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        nowIso: NOW_ISO,
      }),
    ).resolves.toBe(1);

    // Two concurrent runs read the same `detected` row before either marks it.
    const [first, second] = await Promise.all([
      loadPatternsContext(runtime.repositories.patternCandidates, SCOPE),
      loadPatternsContext(runtime.repositories.patternCandidates, SCOPE),
    ]);

    const surfaced = [first, second].filter(
      (context) => context.surfacedCandidateIds.length > 0,
    );
    const dropped = [first, second].filter(
      (context) => context.surfacedCandidateIds.length === 0,
    );

    // Exactly ONE run surfaces; the loser drops it cleanly.
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0].block).toContain(OUTCOME);
    expect(surfaced[0].surfacedCandidateIds).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toEqual({ block: '', surfacedCandidateIds: [] });

    // The row was claimed exactly once: it is now `suggested`, not `detected`.
    const claimed = await runtime.repositories.patternCandidates.getById(
      surfaced[0].surfacedCandidateIds[0],
    );
    expect(claimed?.candidateStatus).toBe('suggested');
  });
});

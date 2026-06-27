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

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

interface KeyingCase {
  label: string;
  scope: PatternSubjectScope;
  negativeScope: PatternSubjectScope;
  expectedSubjectType: PatternSubjectTuple['subjectType'];
  outcomeLabel: string;
}

const CASES: KeyingCase[] = [
  {
    label: 'dm user',
    scope: {
      appId: 'pattern_keying_app_dm',
      agentId: 'pattern_keying_agent_dm',
      folder: 'pattern-keying-dm-folder',
      conversationKind: 'dm',
      conversationId: 'dm-conversation-1',
      userId: 'dm-user-1',
    },
    negativeScope: {
      appId: 'pattern_keying_app_dm',
      agentId: 'pattern_keying_agent_dm',
      folder: 'pattern-keying-dm-folder',
      conversationKind: 'dm',
      conversationId: 'dm-conversation-2',
      userId: 'dm-user-2',
    },
    expectedSubjectType: 'user',
    outcomeLabel: 'summarize the weekly report for dm',
  },
  {
    label: 'channel',
    scope: {
      appId: 'pattern_keying_app_channel',
      agentId: 'pattern_keying_agent_channel',
      folder: 'pattern-keying-channel-folder',
      conversationKind: 'channel',
      conversationId: 'sl:C123',
    },
    negativeScope: {
      appId: 'pattern_keying_app_channel',
      agentId: 'pattern_keying_agent_channel',
      folder: 'pattern-keying-channel-folder',
      conversationKind: 'channel',
      conversationId: 'sl:C999',
    },
    expectedSubjectType: 'channel',
    outcomeLabel: 'summarize the weekly report for channel',
  },
  {
    label: 'group',
    scope: {
      appId: 'pattern_keying_app_group',
      agentId: 'pattern_keying_agent_group',
      folder: 'pattern-keying-group-folder',
      conversationKind: 'channel',
    },
    negativeScope: {
      appId: 'pattern_keying_app_group',
      agentId: 'pattern_keying_agent_group',
      folder: 'pattern-keying-other-group-folder',
      conversationKind: 'channel',
    },
    expectedSubjectType: 'group',
    outcomeLabel: 'summarize the weekly report for group',
  },
];

const WINDOW_START = '2026-06-01T00:00:00.000Z';
const WINDOW_END = '2026-06-07T00:00:00.000Z';
const NOW_ISO = '2026-06-08T00:00:00.000Z';

function transcriptTurns(label: string, outcomeLabel: string) {
  return [
    { intent: outcomeLabel, messageId: `${label}-m1` },
    { intent: outcomeLabel, messageId: `${label}-m2` },
    { intent: outcomeLabel, messageId: `${label}-m3` },
    // >= PATTERN_VALUE_FLOOR_MIN_OCCURRENCES (4) so the candidate clears the
    // recurrence value floor; this test exercises subject keying, not the floor.
    { intent: outcomeLabel, messageId: `${label}-m4` },
  ];
}

async function writeDetectedCandidate(input: {
  runtime: PostgresIntegrationRuntime;
  subject: PatternSubjectTuple;
  label: string;
  outcomeLabel: string;
}): Promise<void> {
  await expect(
    detectAndUpsertPatternCandidates({
      db: input.runtime.service.db,
      subject: { ...input.subject },
      transcriptTurns: transcriptTurns(input.label, input.outcomeLabel),
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      nowIso: NOW_ISO,
    }),
  ).resolves.toBe(1);
}

const EMPTY_DM_APP_ID = 'pattern_keying_app_empty_dm';

maybeDescribe('pattern candidate subject keying', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'pattern_keying',
    });
    // pattern_candidates.app_id has an FK to apps.id; seed the apps the cases use.
    const now = new Date().toISOString();
    const appIds = new Set([
      ...CASES.map((testCase) => testCase.scope.appId),
      EMPTY_DM_APP_ID,
    ]);
    for (const appId of appIds) {
      await runtime.repositories.apps.saveApp({
        id: appId as never,
        slug: appId,
        name: appId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  for (const testCase of CASES) {
    it(`uses the same write/read subject for ${testCase.label}`, async () => {
      const subject = patternSubjectForScope(testCase.scope);
      expect(subject).toMatchObject({
        subjectType: testCase.expectedSubjectType,
      });
      expect(subject).not.toBeNull();

      await writeDetectedCandidate({
        runtime,
        subject: subject as PatternSubjectTuple,
        label: testCase.label,
        outcomeLabel: testCase.outcomeLabel,
      });

      const sameContext = await loadPatternsContext(
        runtime.repositories.patternCandidates,
        testCase.scope,
      );
      expect(sameContext.block).toContain(testCase.outcomeLabel);
      expect(sameContext.surfacedCandidateIds).toHaveLength(1);

      const otherContext = await loadPatternsContext(
        runtime.repositories.patternCandidates,
        testCase.negativeScope,
      );
      expect(otherContext).toEqual({
        block: '',
        surfacedCandidateIds: [],
      });
    });
  }

  it('reads nothing for an empty-user DM even when a channel candidate exists', async () => {
    const channelScope: PatternSubjectScope = {
      appId: EMPTY_DM_APP_ID,
      agentId: 'pattern_keying_agent_empty_dm',
      folder: 'pattern-keying-empty-dm-folder',
      conversationKind: 'channel',
      conversationId: 'sl:CEMPTY',
    };
    const channelSubject = patternSubjectForScope(channelScope);
    expect(channelSubject).not.toBeNull();
    await writeDetectedCandidate({
      runtime,
      subject: channelSubject as PatternSubjectTuple,
      label: 'empty-dm-channel',
      outcomeLabel: 'summarize the weekly report for empty dm leak check',
    });

    const emptyDmScope: PatternSubjectScope = {
      ...channelScope,
      conversationKind: 'dm',
    };
    expect(patternSubjectForScope(emptyDmScope)).toBeNull();

    await expect(
      loadPatternsContext(runtime.repositories.patternCandidates, emptyDmScope),
    ).resolves.toEqual({
      block: '',
      surfacedCandidateIds: [],
    });
  });
});

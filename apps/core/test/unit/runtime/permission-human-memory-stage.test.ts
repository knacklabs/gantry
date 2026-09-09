import { describe, expect, it, vi } from 'vitest';

import { PermissionLane } from '@core/domain/permission-lane.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
  type PermissionDecisionMemoryRepository,
  type PermissionDecisionMemoryRow,
} from '@core/domain/ports/permission-decision-memory.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import {
  consultRememberedAllow,
  consultRememberedDeny,
  type PermissionHumanMemoryStageInput,
} from '@core/runtime/permission-human-memory-stage.js';

const CREATED_AT = '2026-09-07T10:11:12.000Z';

function request(
  toolName = 'WebRead',
  toolInput: Record<string, unknown> = { url: 'https://example.com' },
): PermissionApprovalRequest {
  return {
    requestId: `permission-${toolName}`,
    sourceAgentFolder: 'main_agent',
    appId: 'app-one',
    personId: 'person-one',
    toolName,
    toolInput,
  };
}

function row(input: {
  outcome: (typeof HumanDecisionOutcome)[keyof typeof HumanDecisionOutcome];
  scope: (typeof HumanDecisionScope)[keyof typeof HumanDecisionScope];
  scopeKey: string;
}): PermissionDecisionMemoryRow {
  return {
    id: `row-${input.scope}-${input.scopeKey}`,
    appId: 'app-one',
    agentFolder: 'main_agent',
    kind: 'human_decision',
    lookupIdentity: input.scopeKey,
    decision: input.outcome,
    outcome: input.outcome,
    scope: input.scope,
    scopeKey: input.scopeKey,
    actingPersonId: 'person-one',
    reason: 'remembered',
    effectSchemaVersion: 3,
    railVersion: 2,
    provenance: 'human_decision:test',
    createdAt: CREATED_AT,
  };
}

function memory(
  findHumanDecision: PermissionDecisionMemoryRepository['findHumanDecision'],
): PermissionDecisionMemoryRepository {
  return { findHumanDecision } as PermissionDecisionMemoryRepository;
}

function stageInput(
  overrides: Partial<PermissionHumanMemoryStageInput> = {},
): PermissionHumanMemoryStageInput {
  return {
    request: request(),
    analysis: {
      lane: PermissionLane.InteractiveAuto,
      readOnlyMetaExecutor: false,
    },
    effectHash: 'effect-hash',
    canonicalRoot: '/canonical/root',
    decisionMemory: memory(async () => null),
    ...overrides,
  };
}

describe('permission human memory stage', () => {
  it('consults remembered decisions only under interactive_auto with a person, a memory port and an effect hash, derives every candidate key through the T3a scope module, returns the remembered No before anything else and the remembered Allow in exact then trust-growth kind then category kind then trust-growth place then category place order with the exact reason lines and human_decision provenance, matches a kind tool row for that tool and misses it for another tool, matches a place row only for the same kind under the root, and fails closed on a port error', async () => {
    const guardedFind = vi.fn(async () => null);
    for (const consult of [consultRememberedDeny, consultRememberedAllow]) {
      for (const analysis of [
        { lane: PermissionLane.Ask, readOnlyMetaExecutor: false },
        { lane: PermissionLane.AutoStrict, readOnlyMetaExecutor: false },
        { lane: PermissionLane.Autonomous, readOnlyMetaExecutor: false },
      ]) {
        await expect(
          consult(
            stageInput({
              analysis,
              decisionMemory: memory(guardedFind),
            }),
          ),
        ).resolves.toBeUndefined();
      }
      await expect(
        consult(
          stageInput({
            request: { ...request(), personId: ' ' },
            decisionMemory: memory(guardedFind),
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        consult(stageInput({ decisionMemory: undefined })),
      ).resolves.toBeUndefined();
      await expect(
        consult(
          stageInput({
            effectHash: undefined,
            decisionMemory: memory(guardedFind),
          }),
        ),
      ).resolves.toBeUndefined();
    }
    expect(guardedFind).not.toHaveBeenCalled();

    const orderedFind = vi.fn(async () => null);
    await consultRememberedAllow(
      stageInput({ decisionMemory: memory(orderedFind) }),
    );
    expect(orderedFind).toHaveBeenCalledWith({
      appId: 'app-one',
      agentFolder: 'main_agent',
      actingPersonId: 'person-one',
      candidates: [
        { scope: 'exact', scopeKey: 'effect-hash' },
        { scope: 'kind', scopeKey: 'kind:tool:WebRead' },
        { scope: 'kind', scopeKey: 'kind:web_read' },
        {
          scope: 'place',
          scopeKey: 'place:tool:WebRead:/canonical/root',
        },
        { scope: 'place', scopeKey: 'place:web_read:/canonical/root' },
      ],
      railVersion: 2,
    });

    const exactOnlyFind = vi.fn(async () => null);
    await consultRememberedAllow(
      stageInput({ decisionMemory: memory(exactOnlyFind) }),
      { exactOnly: true },
    );
    expect(exactOnlyFind).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [{ scope: 'exact', scopeKey: 'effect-hash' }],
      }),
    );

    const deny = row({
      outcome: HumanDecisionOutcome.Deny,
      scope: HumanDecisionScope.Exact,
      scopeKey: 'effect-hash',
    });
    await expect(
      consultRememberedDeny(
        stageInput({ decisionMemory: memory(async () => deny) }),
      ),
    ).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'human_decision',
      source: 'human_decision',
      repeatableForFutureRuns: true,
      reason:
        'denied by your remembered No to this exact command (2026-09-07) — /permissions to change',
    });

    for (const [scope, scopeKey, words] of [
      ['exact', 'effect-hash', 'this exact action'],
      ['kind', 'kind:web_read', 'this kind of action, anywhere'],
      [
        'place',
        'place:web_read:/canonical/root',
        'anything of this kind under /canonical/root',
      ],
    ] as const) {
      const allow = row({
        outcome: HumanDecisionOutcome.Allow,
        scope,
        scopeKey,
      });
      await expect(
        consultRememberedAllow(
          stageInput({ decisionMemory: memory(async () => allow) }),
        ),
      ).resolves.toMatchObject({
        approved: true,
        mode: 'allow_once',
        decidedBy: 'human_decision',
        source: 'human_decision',
        repeatableForFutureRuns: true,
        reason: `allowed by your remembered Allow (${words}, 2026-09-07) — /permissions to change`,
      });
    }

    const seeded = new Map<string, PermissionDecisionMemoryRow>([
      [
        'kind:kind:tool:scheduler_delete_job',
        row({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Kind,
          scopeKey: 'kind:tool:scheduler_delete_job',
        }),
      ],
      [
        'place:place:tool:scheduler_delete_job:/canonical/root',
        row({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Place,
          scopeKey: 'place:tool:scheduler_delete_job:/canonical/root',
        }),
      ],
      [
        'place:place:web_read:/canonical/root',
        row({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Place,
          scopeKey: 'place:web_read:/canonical/root',
        }),
      ],
    ]);
    const seededMemory = memory(async ({ candidates }) => {
      for (const candidate of candidates) {
        const match = seeded.get(`${candidate.scope}:${candidate.scopeKey}`);
        if (match) return match;
      }
      return null;
    });
    await expect(
      consultRememberedAllow(
        stageInput({
          request: request('mcp__gantry__scheduler_delete_job', { jobId: '1' }),
          canonicalRoot: undefined,
          decisionMemory: seededMemory,
        }),
      ),
    ).resolves.toMatchObject({ decidedBy: 'human_decision' });
    await expect(
      consultRememberedAllow(
        stageInput({
          request: request('mcp__gantry__scheduler_update_job', { jobId: '1' }),
          canonicalRoot: undefined,
          decisionMemory: seededMemory,
        }),
      ),
    ).resolves.toBeUndefined();
    seeded.delete('kind:kind:tool:scheduler_delete_job');
    await expect(
      consultRememberedAllow(
        stageInput({
          request: request('mcp__gantry__scheduler_delete_job', { jobId: '1' }),
          decisionMemory: seededMemory,
        }),
      ),
    ).resolves.toMatchObject({
      reason:
        'allowed by your remembered Allow (anything of this kind under /canonical/root, 2026-09-07) — /permissions to change',
    });
    await expect(
      consultRememberedAllow(stageInput({ decisionMemory: seededMemory })),
    ).resolves.toMatchObject({ decidedBy: 'human_decision' });
    await expect(
      consultRememberedAllow(
        stageInput({
          request: request('WebSearch', { query: 'gantry' }),
          decisionMemory: seededMemory,
        }),
      ),
    ).resolves.toBeUndefined();

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(
      consultRememberedAllow(
        stageInput({
          decisionMemory: memory(async () => {
            throw new Error('database unavailable');
          }),
        }),
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

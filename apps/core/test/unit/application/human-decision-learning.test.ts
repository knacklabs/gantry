import { describe, expect, it, vi } from 'vitest';

import { deriveAutoLaneAnalysis } from '@core/application/permissions/auto-lane-analysis.js';
import {
  derivePermissionRememberContext,
  learnRememberedDecision,
  parsePermissionRememberContext,
  type PermissionRememberContext,
} from '@core/application/permissions/human-decision-learning.js';
import type { HumanDecisionServiceRefusal } from '@core/application/permissions/human-decision-memory-service.js';
import {
  decodePermissionDecisionCode,
  encodePermissionRememberCode,
} from '@core/application/permissions/permission-remember-codec.js';
import {
  deriveHumanDecisionScopeKey,
  HumanDecisionNotRememberableReason,
} from '@core/application/permissions/human-decision-scope.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
  type PermissionRememberResolution,
} from '@core/domain/human-decision.js';
import { PermissionLane } from '@core/domain/permission-lane.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

const request: PermissionApprovalRequest = {
  requestId: 'permission-one',
  sourceAgentFolder: 'main_agent',
  toolName: 'Bash',
  toolInput: { command: 'ls' },
};

const resolutions = {
  deny: {
    kind: 'remember',
    outcome: HumanDecisionOutcome.Deny,
    scope: HumanDecisionScope.Exact,
  },
  exact: {
    kind: 'remember',
    outcome: HumanDecisionOutcome.Allow,
    scope: HumanDecisionScope.Exact,
  },
  kind: {
    kind: 'remember',
    outcome: HumanDecisionOutcome.Allow,
    scope: HumanDecisionScope.Kind,
  },
  place: {
    kind: 'remember',
    outcome: HumanDecisionOutcome.Allow,
    scope: HumanDecisionScope.Place,
  },
} as const satisfies Record<string, PermissionRememberResolution>;

async function context(
  overrides: Partial<
    Parameters<typeof derivePermissionRememberContext>[0]
  > = {},
) {
  const laneInput = overrides.laneInput ?? { permissionMode: 'auto' as const };
  return derivePermissionRememberContext({
    request,
    facts: {
      analysis: deriveAutoLaneAnalysis(laneInput),
      effectHash: 'effect-one',
      workspaceRoot: '/workspace',
    },
    laneInput,
    appId: 'app-one',
    agentFolder: 'main_agent',
    canonicalTool: 'Bash',
    personId: 'person-one',
    effectSchemaVersion: 3,
    railVersion: 7,
    kindVariant: 'category',
    ...overrides,
  });
}

describe('human decision learning', () => {
  it('derives a remember context whose provisional eligibility holds only for an interactive_auto lane with a person and no scheduled job, whose exact, category-kind and tool-kind candidates equal a fresh derivation including each typed refusal reason, resolves a place code to no_root, encodes a deny with kind or place scope to null, parses every malformed context field class to null with no learning while the scalar result settles, and learns from it by picking the candidate for the resolved scope with kindVariant choosing between the two kind candidates, relaying every service refusal, and returning unlearned without throwing when the port fails', async () => {
    const derived = await context();
    expect(derived.eligible).toBe(true);
    expect(derived.lane).toBe(PermissionLane.InteractiveAuto);
    expect(parsePermissionRememberContext(derived)).toEqual(derived);

    for (const [laneInput, personId] of [
      [{ permissionMode: 'ask' as const }, 'person-one'],
      [{ permissionMode: 'auto_strict' as const }, 'person-one'],
      [{ permissionMode: 'auto' as const, hostJobId: 'job-one' }, 'person-one'],
      [{ permissionMode: 'auto' as const }, ' '],
    ] as const) {
      expect(await context({ laneInput, personId })).toMatchObject({
        eligible: false,
      });
    }

    const candidateInput = {
      request,
      effectHash: 'effect-one',
      workspaceRoot: '/workspace',
      trustGrowthTool: false,
    };
    await expect(
      Promise.all([
        deriveHumanDecisionScopeKey({
          ...candidateInput,
          outcome: HumanDecisionOutcome.Deny,
          scope: HumanDecisionScope.Exact,
        }),
        deriveHumanDecisionScopeKey({
          ...candidateInput,
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Exact,
        }),
        deriveHumanDecisionScopeKey({
          ...candidateInput,
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Kind,
        }),
        deriveHumanDecisionScopeKey({
          ...candidateInput,
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Kind,
          trustGrowthTool: true,
        }),
      ]),
    ).resolves.toEqual([
      derived.candidates.deny,
      derived.candidates.exact,
      derived.candidates.kind,
      derived.candidates.kindTool,
    ]);

    const refused = await context({
      request: {
        ...request,
        toolName: 'FileWrite',
        toolInput: { path: 'settings.yaml', content: 'x' },
      },
      facts: {
        analysis: deriveAutoLaneAnalysis({ permissionMode: 'auto' }),
        effectHash: undefined,
        workspaceRoot: '/workspace',
      },
      canonicalTool: 'FileWrite',
    });
    expect(refused.candidates).toMatchObject({
      deny: {
        ok: false,
        reason: HumanDecisionNotRememberableReason.IncompleteEffect,
      },
      exact: {
        ok: false,
        reason: HumanDecisionNotRememberableReason.ProtectedDestination,
      },
      kind: {
        ok: false,
        reason: HumanDecisionNotRememberableReason.NoCategory,
      },
    });

    expect(
      encodePermissionRememberCode({
        ...resolutions.deny,
        scope: HumanDecisionScope.Kind,
      }),
    ).toBeNull();
    expect(
      encodePermissionRememberCode({
        ...resolutions.deny,
        scope: HumanDecisionScope.Place,
      }),
    ).toBeNull();

    const rememberDerived = vi.fn(async () => ({
      status: 'remembered' as const,
      id: 'decision-one',
      shortId: 'decisi',
      scopeKey: 'unused',
      pathOnly: false,
      stored: 'inserted' as const,
    }));
    const service = { rememberDerived };
    const warn = vi.fn();
    for (const [resolution, scopeKey] of [
      [
        resolutions.deny,
        derived.candidates.deny.ok && derived.candidates.deny.scopeKey,
      ],
      [
        resolutions.exact,
        derived.candidates.exact.ok && derived.candidates.exact.scopeKey,
      ],
      [
        resolutions.kind,
        derived.candidates.kind.ok && derived.candidates.kind.scopeKey,
      ],
    ] as const) {
      await expect(
        learnRememberedDecision({
          context: derived,
          resolution,
          service,
          warn,
        }),
      ).resolves.toEqual({ status: 'remembered', id: 'decision-one' });
      expect(rememberDerived).toHaveBeenLastCalledWith(
        expect.objectContaining({ scopeKey }),
      );
    }
    await learnRememberedDecision({
      context: { ...derived, kindVariant: 'tool' },
      resolution: resolutions.kind,
      service,
      warn,
    });
    expect(rememberDerived).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scopeKey:
          derived.candidates.kindTool.ok &&
          derived.candidates.kindTool.scopeKey,
      }),
    );
    await expect(
      learnRememberedDecision({
        context: derived,
        resolution: resolutions.place,
        service,
        warn,
      }),
    ).resolves.toEqual({
      status: 'not_rememberable',
      reason: HumanDecisionNotRememberableReason.NoRoot,
    });
    await expect(
      learnRememberedDecision({
        context: derived,
        resolution: {
          ...resolutions.deny,
          scope: HumanDecisionScope.Kind,
        },
        service,
        warn,
      }),
    ).resolves.toEqual({
      status: 'not_rememberable',
      reason: HumanDecisionNotRememberableReason.DenyRequiresExact,
    });
    await expect(
      learnRememberedDecision({
        context: { ...derived, eligible: false },
        resolution: resolutions.exact,
        service,
        warn,
      }),
    ).resolves.toEqual({ status: 'not_eligible' });

    const serviceRefusals: HumanDecisionServiceRefusal[] = [
      HumanDecisionNotRememberableReason.ProtectedDestination,
      HumanDecisionNotRememberableReason.NoCategory,
      HumanDecisionNotRememberableReason.NoRoot,
      HumanDecisionNotRememberableReason.IncompleteEffect,
      HumanDecisionNotRememberableReason.DenyRequiresExact,
      'unresolved_person',
      'once_never_remembered',
    ];
    for (const reason of serviceRefusals) {
      rememberDerived.mockResolvedValueOnce({
        status: 'not_rememberable' as const,
        reason,
      });
      await expect(
        learnRememberedDecision({
          context: derived,
          resolution: resolutions.exact,
          service,
          warn,
        }),
      ).resolves.toEqual({ status: 'not_rememberable', reason });
    }

    const malformed: unknown[] = [
      { ...derived, eligible: 'yes' },
      { ...derived, lane: 'interactive' },
      { ...derived, laneInput: null },
      { ...derived, laneInput: { permissionMode: 'sometimes' } },
      { ...derived, laneInput: { permissionMode: 'auto', hostJobId: 1 } },
      { ...derived, appId: '' },
      { ...derived, agentFolder: 1 },
      { ...derived, canonicalTool: ' ' },
      { ...derived, personId: 1 },
      { ...derived, personLabel: false },
      { ...derived, effectHash: '' },
      { ...derived, effectSchemaVersion: 1.5 },
      { ...derived, railVersion: '7' },
      { ...derived, workspaceRoot: false },
      { ...derived, kindVariant: 'place' },
      { ...derived, candidates: null },
      {
        ...derived,
        candidates: {
          ...derived.candidates,
          exact: { ok: true, scopeKey: '' },
        },
      },
      {
        ...derived,
        candidates: {
          ...derived.candidates,
          kind: { ok: false, reason: 'other' },
        },
      },
    ];
    const writesBeforeMalformed = rememberDerived.mock.calls.length;
    for (const value of malformed) {
      expect(parsePermissionRememberContext(value)).toBeNull();
      expect(decodePermissionDecisionCode('remember_allow_exact')?.mode).toBe(
        'allow_once',
      );
    }
    expect(rememberDerived).toHaveBeenCalledTimes(writesBeforeMalformed);

    rememberDerived.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      learnRememberedDecision({
        context: derived,
        resolution: resolutions.exact,
        service,
        warn,
      }),
    ).resolves.toEqual({ status: 'unlearned' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { projectHumanDecisionMatch } from '@core/application/permissions/human-decision-job-projection.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
} from '@core/domain/human-decision.js';
import type {
  PermissionDecisionMemoryRepository,
  PermissionDecisionMemoryRow,
} from '@core/domain/ports/permission-decision-memory.js';
import { RAIL_CATALOG_VERSION } from '@core/domain/permission-effect-key.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

const request: PermissionApprovalRequest = {
  requestId: 'projection-request',
  sourceAgentFolder: 'main_agent',
  toolName: 'RunCommand',
  toolInput: { command: 'cat report.txt' },
};

function row(
  outcome: (typeof HumanDecisionOutcome)[keyof typeof HumanDecisionOutcome],
  scope: (typeof HumanDecisionScope)[keyof typeof HumanDecisionScope],
): PermissionDecisionMemoryRow {
  return {
    id: `human-${outcome}-${scope}`,
    appId: 'default',
    agentFolder: 'main_agent',
    kind: 'human_decision',
    lookupIdentity: 'scope-key',
    decision: outcome,
    outcome,
    scope,
    scopeKey: 'scope-key',
    actingPersonId: 'person-a',
    reason: 'remembered',
    effectSchemaVersion: 3,
    railVersion: RAIL_CATALOG_VERSION,
    provenance: 'human_decision:test',
    createdAt: '2026-09-08T00:00:00.000Z',
  };
}

describe('projectHumanDecisionMatch', () => {
  it('passes the five candidates in the interactive order returns the record id and scope for an allow row and null for a deny row a blank owner a place without root a derivation refusal and a throwing repository with one warn', async () => {
    const findHumanDecision: PermissionDecisionMemoryRepository['findHumanDecision'] =
      vi
        .fn()
        .mockResolvedValueOnce(
          row(HumanDecisionOutcome.Allow, HumanDecisionScope.Kind),
        )
        .mockResolvedValueOnce(
          row(HumanDecisionOutcome.Deny, HumanDecisionScope.Exact),
        );
    const warn = vi.fn();
    const base = {
      ownerPersonId: ' person-a ',
      request,
      facts: {
        effectHash: 'effect-1',
        workspaceRoot: '/workspace',
        canonicalRoot: '/workspace',
      },
      railVersion: RAIL_CATALOG_VERSION,
      memory: { findHumanDecision } as never,
      warn,
    };

    await expect(projectHumanDecisionMatch(base)).resolves.toEqual({
      recordId: 'human-allow-kind',
      scope: HumanDecisionScope.Kind,
    });
    expect(findHumanDecision).toHaveBeenNthCalledWith(1, {
      appId: 'default',
      agentFolder: 'main_agent',
      actingPersonId: 'person-a',
      candidates: [
        { scope: HumanDecisionScope.Exact, scopeKey: 'effect-1' },
        {
          scope: HumanDecisionScope.Kind,
          scopeKey: 'kind:tool:RunCommand',
        },
        { scope: HumanDecisionScope.Kind, scopeKey: 'kind:file_read' },
        {
          scope: HumanDecisionScope.Place,
          scopeKey: 'place:tool:RunCommand:/workspace',
        },
        {
          scope: HumanDecisionScope.Place,
          scopeKey: 'place:file_read:/workspace',
        },
      ],
      railVersion: RAIL_CATALOG_VERSION,
    });
    await expect(projectHumanDecisionMatch(base)).resolves.toBeNull();

    findHumanDecision.mockClear();
    await expect(
      projectHumanDecisionMatch({
        ...base,
        ownerPersonId: ' ',
        facts: { ...base.facts, canonicalRoot: undefined },
      }),
    ).resolves.toBeNull();
    expect(findHumanDecision).not.toHaveBeenCalled();

    findHumanDecision.mockResolvedValue(null);
    await expect(
      projectHumanDecisionMatch({
        ...base,
        facts: { ...base.facts, canonicalRoot: undefined },
      }),
    ).resolves.toBeNull();
    expect(findHumanDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidates: [
          { scope: HumanDecisionScope.Exact, scopeKey: 'effect-1' },
          {
            scope: HumanDecisionScope.Kind,
            scopeKey: 'kind:tool:RunCommand',
          },
          { scope: HumanDecisionScope.Kind, scopeKey: 'kind:file_read' },
        ],
      }),
    );

    await expect(
      projectHumanDecisionMatch({
        ...base,
        request: { ...request, toolInput: undefined },
        facts: {
          workspaceRoot: '/workspace',
          canonicalRoot: undefined,
        },
      }),
    ).resolves.toBeNull();
    expect(findHumanDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidates: [
          {
            scope: HumanDecisionScope.Kind,
            scopeKey: 'kind:tool:RunCommand',
          },
        ],
      }),
    );

    const throwingRepository = {
      findHumanDecision: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    } as never;
    await expect(
      projectHumanDecisionMatch({ ...base, memory: throwingRepository }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'Human permission decision job projection lookup failed',
      { errorName: 'Error' },
    );
  });
});

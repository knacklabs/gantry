import { describe, expect, it, vi } from 'vitest';

import {
  deriveHumanDecisionShortIds,
  HumanDecisionMemoryService,
} from '@core/application/permissions/human-decision-memory-service.js';
import { HumanDecisionNotRememberableReason } from '@core/application/permissions/human-decision-scope.js';
import {
  HUMAN_DECISION_MEMORY_KIND,
  type PermissionDecisionMemoryRepository,
  type PermissionDecisionMemoryRow,
} from '@core/domain/ports/permission-decision-memory.js';
import {
  decodeHumanDecisionProvenance,
  HumanDecisionOutcome,
  HumanDecisionScope,
  type HumanDecisionRememberRequest,
} from '@core/domain/human-decision.js';
import type { PermissionApprovalDecisionMode } from '@core/domain/types.js';

const ID = '12345678-1234-4abc-8def-1234567890ab';
const STORED_ID = 'abcdef00-1234-4abc-8def-1234567890ab';
const COLLIDING_ID = 'abcdef10-1234-4abc-8def-1234567890ab';
const NOW = '2026-09-06T00:00:00.000Z';

function fakeRepository(
  overrides: Partial<PermissionDecisionMemoryRepository> = {},
) {
  return {
    getClassifierVerdict: vi.fn(async () => null),
    putClassifierVerdict: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    revoke: vi.fn(async () => false),
    putHumanDecision: vi.fn(async (input) => ({
      id: input.id,
      status: 'inserted' as const,
    })),
    listHumanDecisions: vi.fn(async () => []),
    findHumanDecision: vi.fn(async () => null),
    revokeById: vi.fn(async () => 'not_found' as const),
    countExactAllowsByTool: vi.fn(async () => ({})),
    ...overrides,
  } satisfies PermissionDecisionMemoryRepository;
}

function rememberRequest(
  overrides: Partial<HumanDecisionRememberRequest> = {},
): HumanDecisionRememberRequest {
  return {
    appId: 'app-one',
    agentFolder: 'main_agent',
    actingPersonId: 'person-one',
    actingPersonLabel: 'Alex',
    resolution: {
      kind: 'remember',
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Exact,
    },
    request: {
      requestId: 'permission-one',
      sourceAgentFolder: 'main_agent',
      toolName: 'file',
      toolInput: { action: 'write', path: 'notes/a.md', content: 'hello' },
    },
    effectHash: 'effect-one',
    railVersion: 7,
    effectSchemaVersion: 3,
    reason: 'Allow this file write here.',
    ...overrides,
  };
}

function humanRow(
  id: string,
  actingPersonId = 'person-one',
  createdAt = NOW,
): PermissionDecisionMemoryRow {
  return {
    id,
    appId: 'app-one',
    agentFolder: 'main_agent',
    kind: HUMAN_DECISION_MEMORY_KIND,
    lookupIdentity: 'effect-one',
    effectHash: 'effect-one',
    decision: HumanDecisionOutcome.Allow,
    outcome: HumanDecisionOutcome.Allow,
    scope: HumanDecisionScope.Exact,
    scopeKey: 'effect-one',
    actingPersonId,
    actingPersonLabel: 'Alex',
    reason: 'remembered',
    principal: 'WebSearch',
    effectSchemaVersion: 3,
    railVersion: 7,
    provenance: 'human_decision:test',
    createdAt,
  };
}

describe('human decision memory service', () => {
  it('rememberDerived writes the same row as remember for the same key and relays the same refusals', async () => {
    const repository = fakeRepository({
      listHumanDecisions: vi.fn(async () => [humanRow(ID)]),
    });
    const service = new HumanDecisionMemoryService({
      repository,
      newId: () => ID,
      now: () => NOW,
    });

    const remembered = await service.remember(rememberRequest());
    const firstWrite = repository.putHumanDecision.mock.calls[0]![0];
    repository.putHumanDecision.mockClear();
    const derived = await service.rememberDerived({
      appId: 'app-one',
      agentFolder: 'main_agent',
      actingPersonId: 'person-one',
      actingPersonLabel: 'Alex',
      canonicalTool: 'file',
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Exact,
      scopeKey: firstWrite.scopeKey!,
      pathOnly: true,
      effectHash: 'effect-one',
      effectSchemaVersion: 3,
      railVersion: 7,
      reason: 'Allow this file write here.',
    });

    expect(derived).toEqual(remembered);
    expect(repository.putHumanDecision).toHaveBeenCalledWith(firstWrite);
    await expect(
      service.rememberDerived({
        appId: 'app-one',
        agentFolder: 'main_agent',
        actingPersonId: ' ',
        canonicalTool: 'file',
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Exact,
        scopeKey: 'key',
        pathOnly: false,
        effectSchemaVersion: 3,
        railVersion: 7,
        reason: 'remembered',
      }),
    ).resolves.toEqual({
      status: 'not_rememberable',
      reason: 'unresolved_person',
    });
    await expect(
      service.rememberDerived({
        appId: 'app-one',
        agentFolder: 'main_agent',
        actingPersonId: 'person-one',
        canonicalTool: 'file',
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Exact,
        scopeKey: ' ',
        pathOnly: false,
        effectSchemaVersion: 3,
        railVersion: 7,
        reason: 'remembered',
      }),
    ).resolves.toEqual({
      status: 'not_rememberable',
      reason: HumanDecisionNotRememberableReason.IncompleteEffect,
    });
    await expect(
      service.rememberDerived({
        appId: 'app-one',
        agentFolder: 'main_agent',
        actingPersonId: 'person-one',
        canonicalTool: 'file',
        outcome: HumanDecisionOutcome.Deny,
        scope: HumanDecisionScope.Kind,
        scopeKey: 'key',
        pathOnly: false,
        effectSchemaVersion: 3,
        railVersion: 7,
        reason: 'remembered',
      }),
    ).resolves.toEqual({
      status: 'not_rememberable',
      reason: HumanDecisionNotRememberableReason.DenyRequiresExact,
    });
  });

  it('remember refuses an unresolved person and every scalar mode resolution before any repository call, relays each scope-key refusal reason verbatim, throws on a malformed injected id, writes a v4 uuid row with principal set to the canonical tool and the encoded provenance, and returns the stored id and short id including the refreshed-duplicate case', async () => {
    const repository = fakeRepository();
    const service = new HumanDecisionMemoryService({
      repository,
      newId: () => ID,
      now: () => NOW,
    });

    await expect(
      service.remember(rememberRequest({ actingPersonId: ' ' })),
    ).resolves.toEqual({
      status: 'not_rememberable',
      reason: 'unresolved_person',
    });
    for (const mode of [
      'allow_once',
      'allow_persistent_rule',
      'cancel',
    ] satisfies PermissionApprovalDecisionMode[]) {
      await expect(
        service.remember(
          rememberRequest({ resolution: { kind: 'mode', mode } }),
        ),
      ).resolves.toEqual({
        status: 'not_rememberable',
        reason: 'once_never_remembered',
      });
    }

    const refusals: Array<
      [
        Partial<HumanDecisionRememberRequest>,
        HumanDecisionNotRememberableReason,
      ]
    > = [
      [
        {
          resolution: {
            kind: 'remember',
            outcome: HumanDecisionOutcome.Allow,
            scope: HumanDecisionScope.Exact,
          },
          effectHash: undefined,
          request: {
            ...rememberRequest().request,
            toolName: 'file',
            toolInput: {
              action: 'write',
              path: 'settings.yaml',
              content: 'x',
            },
          },
        },
        HumanDecisionNotRememberableReason.ProtectedDestination,
      ],
      [
        {
          resolution: {
            kind: 'remember',
            outcome: HumanDecisionOutcome.Allow,
            scope: HumanDecisionScope.Kind,
          },
          request: { ...rememberRequest().request, toolName: 'UnknownTool' },
        },
        HumanDecisionNotRememberableReason.NoCategory,
      ],
      [
        {
          resolution: {
            kind: 'remember',
            outcome: HumanDecisionOutcome.Allow,
            scope: HumanDecisionScope.Place,
          },
          canonicalRoot: ' ',
        },
        HumanDecisionNotRememberableReason.NoRoot,
      ],
      [
        {
          request: { ...rememberRequest().request, toolName: 'WebSearch' },
          effectHash: undefined,
        },
        HumanDecisionNotRememberableReason.IncompleteEffect,
      ],
      [
        {
          resolution: {
            kind: 'remember',
            outcome: HumanDecisionOutcome.Deny,
            scope: HumanDecisionScope.Kind,
          },
        },
        HumanDecisionNotRememberableReason.DenyRequiresExact,
      ],
    ];
    for (const [overrides, reason] of refusals) {
      await expect(
        service.remember(rememberRequest(overrides)),
      ).resolves.toEqual({
        status: 'not_rememberable',
        reason,
      });
    }
    expect(repository.putHumanDecision).not.toHaveBeenCalled();

    const malformedIdService = new HumanDecisionMemoryService({
      repository,
      newId: () => 'not-a-uuid',
      now: () => NOW,
    });
    await expect(
      malformedIdService.remember(rememberRequest()),
    ).rejects.toThrow('UUID v4');
    expect(repository.putHumanDecision).not.toHaveBeenCalled();

    repository.listHumanDecisions.mockResolvedValueOnce([humanRow(ID)]);
    await expect(service.remember(rememberRequest())).resolves.toEqual({
      status: 'remembered',
      id: ID,
      shortId: '123456',
      scopeKey: 'exact:path:2:file:default/notes/a.md',
      pathOnly: true,
      stored: 'inserted',
    });
    const allowInput = repository.putHumanDecision.mock.calls[0]![0];
    expect(allowInput).toMatchObject({
      id: ID,
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Exact,
      canonicalTool: 'file',
      reason: 'Allow this file write here.',
      nowIso: NOW,
    });
    expect(decodeHumanDecisionProvenance(allowInput.provenance)).toEqual({
      id: ID,
      actingPersonId: 'person-one',
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Exact,
      railVersion: 7,
    });

    const denyRepository = fakeRepository({
      listHumanDecisions: vi.fn(async () => [humanRow(ID)]),
    });
    const denyService = new HumanDecisionMemoryService({
      repository: denyRepository,
      newId: () => ID,
      now: () => NOW,
    });
    await expect(
      denyService.remember(
        rememberRequest({
          resolution: {
            kind: 'remember',
            outcome: HumanDecisionOutcome.Deny,
            scope: HumanDecisionScope.Exact,
          },
          request: { ...rememberRequest().request, toolName: 'RunCommand' },
          effectHash: 'deny-effect',
        }),
      ),
    ).resolves.toMatchObject({
      status: 'remembered',
      scopeKey: 'deny-effect',
      pathOnly: false,
    });

    const refreshedRepository = fakeRepository({
      putHumanDecision: vi.fn(async () => ({
        id: STORED_ID,
        status: 'refreshed' as const,
      })),
      listHumanDecisions: vi.fn(async () => [humanRow(STORED_ID)]),
    });
    const refreshedService = new HumanDecisionMemoryService({
      repository: refreshedRepository,
      newId: () => ID,
      now: () => NOW,
    });
    await expect(refreshedService.remember(rememberRequest())).resolves.toEqual(
      {
        status: 'remembered',
        id: STORED_ID,
        shortId: 'abcdef',
        scopeKey: 'exact:path:2:file:default/notes/a.md',
        pathOnly: true,
        stored: 'refreshed',
      },
    );

    const concurrentlyRevokedRepository = fakeRepository({
      putHumanDecision: vi.fn(async () => ({
        id: STORED_ID,
        status: 'refreshed' as const,
      })),
      listHumanDecisions: vi.fn(async () => []),
    });
    const concurrentlyRevokedService = new HumanDecisionMemoryService({
      repository: concurrentlyRevokedRepository,
      newId: () => ID,
      now: () => NOW,
    });
    await expect(
      concurrentlyRevokedService.remember(rememberRequest()),
    ).resolves.toMatchObject({
      id: STORED_ID,
      shortId: 'abcdef',
    });
  });

  it('list is person-scoped with short ids derived as six dash-free hex characters extended only on a sibling collision and disambiguated against every active sibling before the limit is applied, revoke relays applied, already_revoked and not_found with the app, folder and person axes, and countExactAllowsByTool relays the repository map', async () => {
    expect(deriveHumanDecisionShortIds([STORED_ID]).get(STORED_ID)).toBe(
      'abcdef',
    );
    const collidingShortIds = deriveHumanDecisionShortIds([
      STORED_ID,
      COLLIDING_ID,
    ]);
    expect(collidingShortIds.get(STORED_ID)).toBe('abcdef0');
    expect(collidingShortIds.get(COLLIDING_ID)).toBe('abcdef1');

    const listHumanDecisions = vi.fn(async () => [
      humanRow(STORED_ID, 'person-one', '2026-09-06T02:00:00.000Z'),
      humanRow(COLLIDING_ID, 'person-one', '2026-09-06T01:00:00.000Z'),
    ]);
    const revokeById = vi
      .fn()
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('already_revoked')
      .mockResolvedValueOnce('not_found');
    const countExactAllowsByTool = vi.fn(async () => ({ file: 2 }));
    const repository = fakeRepository({
      listHumanDecisions,
      revokeById,
      countExactAllowsByTool,
    });
    const service = new HumanDecisionMemoryService({
      repository,
      now: () => NOW,
    });
    await expect(
      service.list({
        appId: 'app-one',
        agentFolder: 'main_agent',
        actingPersonId: 'person-one',
        limit: 1,
      }),
    ).resolves.toMatchObject([{ id: STORED_ID, shortId: 'abcdef0' }]);
    expect(listHumanDecisions).toHaveBeenCalledWith({
      appId: 'app-one',
      agentFolder: 'main_agent',
      actingPersonId: 'person-one',
      limit: 1,
    });

    const revokeInput = {
      appId: 'app-one',
      agentFolder: 'main_agent',
      actingPersonId: 'person-one',
      recordId: STORED_ID,
    };
    await expect(service.revoke(revokeInput)).resolves.toBe('applied');
    await expect(service.revoke(revokeInput)).resolves.toBe('already_revoked');
    await expect(service.revoke(revokeInput)).resolves.toBe('not_found');
    expect(revokeById).toHaveBeenNthCalledWith(1, {
      ...revokeInput,
      nowIso: NOW,
    });

    const countInput = {
      appId: 'app-one',
      agentFolder: 'main_agent',
      actingPersonId: 'person-one',
      railVersion: 7,
    };
    await expect(service.countExactAllowsByTool(countInput)).resolves.toEqual({
      file: 2,
    });
    expect(countExactAllowsByTool).toHaveBeenCalledWith(countInput);
  });

  it('derives a large batch of short ids in one pass', () => {
    const ids = Array.from(
      { length: 500 },
      (_, index) =>
        `${index.toString(16).padStart(6, '0')}00-1234-4abc-8def-1234567890ab`,
    );
    ids[0] = STORED_ID;
    ids[1] = COLLIDING_ID;

    const shortIds = deriveHumanDecisionShortIds(ids);

    expect(shortIds.size).toBe(500);
    expect(shortIds.get(STORED_ID)).toBe('abcdef0');
    expect(shortIds.get(COLLIDING_ID)).toBe('abcdef1');
    expect(
      [...shortIds.values()].filter((shortId) => shortId.length === 7),
    ).toEqual(['abcdef0', 'abcdef1']);
  });
});

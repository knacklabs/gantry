import { describe, expect, it, vi } from 'vitest';

import {
  createUsedByJobReader,
  formatPermissionMemoryDate,
  PERMISSION_MEMORY_AMBIGUOUS,
  PERMISSION_MEMORY_NOT_FOUND,
  permissionMemoryAgentRouteKey,
  permissionMemoryCommandResponse,
  permissionMemoryListView,
  resolvePermissionMemoryAgentRouteKey,
} from '@core/application/permissions/permission-memory-listing.js';
import type { HumanDecisionMemoryService } from '@core/application/permissions/human-decision-memory-service.js';
import {
  HUMAN_DECISION_MEMORY_KIND,
  type PermissionDecisionMemoryRow,
} from '@core/domain/ports/permission-decision-memory.js';

function row(
  index: number,
  overrides: Partial<PermissionDecisionMemoryRow> = {},
): PermissionDecisionMemoryRow & { shortId: string } {
  const id = `0000000${index}-1234-4abc-8def-1234567890ab`;
  return {
    id,
    shortId: id.replaceAll('-', '').slice(0, 6),
    appId: 'app-one',
    agentFolder: 'agent-one',
    kind: HUMAN_DECISION_MEMORY_KIND,
    lookupIdentity: `key-${index}`,
    decision: 'allow',
    outcome: 'allow',
    scope: 'kind',
    scopeKey: 'kind:read_only_command',
    actingPersonId: 'person-one',
    actingPersonLabel: 'Alex',
    reason: 'remembered',
    principal: 'Bash',
    effectSchemaVersion: 1,
    railVersion: 1,
    provenance: 'human_decision:{}',
    createdAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    ...overrides,
  };
}

function service(
  rows: Array<PermissionDecisionMemoryRow & { shortId: string }>,
) {
  return {
    list: vi.fn(async () => rows),
    revoke: vi.fn(async () => 'applied' as const),
  } as unknown as HumanDecisionMemoryService;
}

function commandInput(
  rows: Array<PermissionDecisionMemoryRow & { shortId: string }>,
  command:
    | { kind: 'permissions_show' }
    | { kind: 'permissions_all' }
    | { kind: 'permissions_forget'; prefix: string },
) {
  return {
    command,
    modeLine: 'Current permission mode: auto (agent/default).',
    conversationKind: 'dm' as const,
    resolvePersonId: async () => 'person-one',
    service: service(rows),
    appId: 'app-one',
    agentFolder: 'agent-one',
    agentId: 'agent-one',
    timezone: 'Asia/Kolkata',
    usedBy: async () => new Map(),
  };
}

describe('permission memory listing', () => {
  it('renders the mode line then the ten newest active rows from scopeKey-decoded T3 rows with Forget affordances carrying a bounded agent route key the footer the empty state and the plain-text all listing with the short id first using exact day-month dates in the configured timezone the someone fallback and the used-by suffix with deleted jobs dropped before the count', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => row(11 - index));
    rows[0] = row(11, {
      scope: 'place',
      scopeKey: 'place:read_only_command:/repo:with:colon',
      actingPersonLabel: undefined,
      createdAt: '2026-09-01T20:00:00.000Z',
    });
    rows[1] = row(10, {
      scope: 'exact',
      scopeKey: 'effect-hash',
      principal: 'Bash',
    });
    const usedBy = new Map([
      [rows[0]!.id, { jobs: ['Nightly import', 'Daily report'], more: 1 }],
    ]);
    const view = permissionMemoryListView({
      modeLine: 'Current permission mode: auto (agent/default).',
      rows,
      agentId: 'agent-one',
      timezone: 'Asia/Kolkata',
      usedBy,
    });

    expect(view.text).toContain(
      'Allow · read-only reads · /repo:with:colon · 2 Sep · someone · used by job Nightly import, Daily report, +1 jobs',
    );
    expect(view.text).toContain('Allow · Bash, this exact call · anywhere');
    expect(view.text).toContain('Showing the 10 newest with buttons. 1 older.');
    expect(view.affordances).toHaveLength(10);
    expect(view.affordances[0]).toEqual({
      recordId: rows[0]!.id,
      agentRouteKey: permissionMemoryAgentRouteKey('agent-one'),
      label: `Forget ${rows[0]!.shortId}`,
    });
    expect(permissionMemoryAgentRouteKey('agent-one')).toHaveLength(12);
    expect(
      resolvePermissionMemoryAgentRouteKey(
        permissionMemoryAgentRouteKey('agent-one'),
        ['agent-one', 'agent-two'],
      ),
    ).toBe('agent-one');
    expect(
      resolvePermissionMemoryAgentRouteKey('unknown', ['agent-one']),
    ).toBeUndefined();
    expect(
      resolvePermissionMemoryAgentRouteKey(
        permissionMemoryAgentRouteKey('agent-one'),
        ['agent-one', 'agent-one'],
      ),
    ).toBeUndefined();
    expect(
      formatPermissionMemoryDate('2026-09-01T20:00:00.000Z', 'Asia/Kolkata'),
    ).toBe('2 Sep');

    const all = permissionMemoryListView({
      modeLine: 'Current permission mode: auto (agent/default).',
      rows,
      agentId: 'agent-one',
      timezone: 'Asia/Kolkata',
    });
    const complete = permissionMemoryListView({
      modeLine: 'Current permission mode: auto (agent/default).',
      rows,
      agentId: 'agent-one',
      timezone: 'Asia/Kolkata',
      all: true,
    });
    expect(
      complete.text.split('\n')[1]?.startsWith(`${rows[0]!.shortId} · Allow`),
    ).toBe(true);
    expect(complete.affordances).toEqual([]);
    expect(all.text).not.toContain(rows[10]!.shortId);
    expect(
      permissionMemoryListView({
        modeLine: 'Current permission mode: auto (agent/default).',
        rows: [],
        agentId: 'agent-one',
        timezone: 'Asia/Kolkata',
      }).text,
    ).toBe(
      'Current permission mode: auto (agent/default).\nNothing remembered yet. Tap Allow on a card and it shows up here.',
    );

    const listJobs = vi.fn(async () => [
      { id: 'one', name: 'Job one' },
      { id: 'two', name: 'Job two' },
      { id: 'three', name: 'Job three' },
    ]);
    const reader = createUsedByJobReader({
      appId: 'app-one',
      permissions: {
        listDecisionsByHumanDecisionRecordId: vi.fn(async () => [
          {
            recordId: rows[0]!.id,
            jobId: 'deleted',
            lastUsedAt: '2026-09-03T00:00:00.000Z',
          },
          {
            recordId: rows[0]!.id,
            jobId: 'one',
            lastUsedAt: '2026-09-02T00:00:00.000Z',
          },
          {
            recordId: rows[0]!.id,
            jobId: 'one',
            lastUsedAt: '2026-09-01T00:00:00.000Z',
          },
          {
            recordId: rows[0]!.id,
            jobId: 'two',
            lastUsedAt: '2026-08-31T00:00:00.000Z',
          },
          {
            recordId: rows[0]!.id,
            jobId: 'three',
            lastUsedAt: '2026-08-30T00:00:00.000Z',
          },
        ]),
      } as never,
      listJobs,
    });
    await expect(reader([rows[0]!.id])).resolves.toEqual(
      new Map([[rows[0]!.id, { jobs: ['Job one', 'Job two'], more: 1 }]]),
    );
    expect(listJobs).toHaveBeenCalledOnce();

    const usedByRows = vi.fn(async () => new Map());
    const newest = commandInput(rows, { kind: 'permissions_show' });
    await permissionMemoryCommandResponse({ ...newest, usedBy: usedByRows });
    expect(usedByRows).toHaveBeenCalledWith(
      rows.slice(0, 10).map(({ id }) => id),
    );
    const allRows = commandInput(rows, { kind: 'permissions_all' });
    await permissionMemoryCommandResponse({ ...allRows, usedBy: usedByRows });
    expect(usedByRows).toHaveBeenLastCalledWith(rows.map(({ id }) => id));
  });

  it("resolves a case-insensitive forget prefix against this person's active current-rails records only revoking one match replying ambiguity with zero revoke calls and not-found for none revoked stale rails or another person", async () => {
    const rows = [
      row(1, {
        id: 'abcdef00-1234-4abc-8def-1234567890ab',
        shortId: 'abcdef',
      }),
      row(2, {
        id: 'abcdef11-1234-4abc-8def-1234567890ab',
        shortId: 'abcdef',
      }),
    ];
    const input = commandInput(rows, {
      kind: 'permissions_forget',
      prefix: 'ABCDEF00',
    });
    const result = await permissionMemoryCommandResponse(input);
    expect(result.text).toBe("Forgot: read-only reads. I'll ask next time.");
    expect(input.service.revoke).toHaveBeenCalledWith({
      appId: 'app-one',
      agentFolder: 'agent-one',
      actingPersonId: 'person-one',
      recordId: rows[0]!.id,
    });

    const ambiguous = commandInput(rows, {
      kind: 'permissions_forget',
      prefix: 'abcdef',
    });
    await expect(permissionMemoryCommandResponse(ambiguous)).resolves.toEqual({
      text: PERMISSION_MEMORY_AMBIGUOUS,
    });
    expect(ambiguous.service.revoke).not.toHaveBeenCalled();

    const absent = commandInput(rows, {
      kind: 'permissions_forget',
      prefix: 'ffff',
    });
    await expect(permissionMemoryCommandResponse(absent)).resolves.toEqual({
      text: PERMISSION_MEMORY_NOT_FOUND,
    });
    expect(absent.service.revoke).not.toHaveBeenCalled();
  });
});

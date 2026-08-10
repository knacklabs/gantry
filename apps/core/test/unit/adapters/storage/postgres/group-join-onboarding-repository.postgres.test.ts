import { describe, expect, it, vi } from 'vitest';

import { PostgresGroupJoinOnboardingRepository } from '@core/adapters/storage/postgres/repositories/group-join-onboarding-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';

function flattenSqlShape(value: unknown, seen = new Set<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => flattenSqlShape(entry, seen)).join(' ');
  }
  const record = value as Record<string | symbol, unknown>;
  return [
    flattenSqlShape(record.value, seen),
    typeof record.name === 'string' ? record.name : '',
    flattenSqlShape(record.queryChunks, seen),
    flattenSqlShape(record.config, seen),
  ].join(' ');
}

function promptedRow() {
  return {
    id: 'opaque-2',
    providerAccountId: 'telegram_main',
    chatJid: 'tg:-1001234',
    status: 'prompted',
    adder: '111',
    approver: '222',
    promptConversationJid: 'tg:222',
    promptAgentFolder: 'main_agent',
    promptedAt: '2026-07-18T00:00:00.000Z',
    dismissedAt: null,
    registeredAt: null,
    leftAt: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('PostgresGroupJoinOnboardingRepository', () => {
  it('claims bootstrap, reclaiming any non-registered row so failures and manual fallbacks stay retryable', async () => {
    const row = promptedRow();
    const returning = vi.fn(async () => [row]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const repository = new PostgresGroupJoinOnboardingRepository({
      insert,
    } as never);

    await expect(
      repository.recordBootstrap({
        id: row.id,
        providerAccountId: row.providerAccountId,
        chatJid: row.chatJid,
        adder: row.adder,
        approver: row.adder,
        promptConversationJid: row.chatJid,
        promptAgentFolder: row.promptAgentFolder,
        now: row.promptedAt,
      }),
    ).resolves.toMatchObject({ id: row.id });

    const conflict = onConflictDoUpdate.mock.calls[0]![0] as {
      target: unknown[];
      set: Record<string, unknown>;
      setWhere: unknown;
    };
    expect(conflict.target).toEqual([
      pgSchema.groupJoinOnboardingPostgres.providerAccountId,
      pgSchema.groupJoinOnboardingPostgres.chatJid,
    ]);
    // The route check upstream is the "already registered" authority; the
    // claim's only guard is the ownership window, so an in-window duplicate
    // burst must NOT reclaim while any stale row (including a 'registered'
    // row whose settings commit never landed) stays reclaimable later.
    const setWhere = flattenSqlShape(conflict.setWhere);
    expect(setWhere).toContain('updated_at');
    expect(setWhere).not.toContain('registered');
    expect(conflict.set).toMatchObject({
      // A reclaim rotates the id (fencing out stale claimants) and clears
      // every terminal timestamp so the re-add can complete onboarding.
      id: row.id,
      status: 'prompted',
      dismissedAt: null,
      registeredAt: null,
      leftAt: null,
    });
  });

  it('recognises only an active person participating in an active direct conversation', async () => {
    const limit = vi.fn(async () => [{ id: 'conversation:dm' }]);
    const where = vi.fn(() => ({ limit }));
    const secondJoin = vi.fn(() => ({ where }));
    const firstJoin = vi.fn(() => ({ innerJoin: secondJoin }));
    const from = vi.fn(() => ({ innerJoin: firstJoin }));
    const select = vi.fn(() => ({ from }));
    const repository = new PostgresGroupJoinOnboardingRepository({
      select,
    } as never);

    await expect(
      repository.hasDirectConversationWithPerson('default', 'person-111'),
    ).resolves.toBe(true);

    expect(from).toHaveBeenCalledWith(pgSchema.userAliasesPostgres);
    expect(firstJoin).toHaveBeenCalledWith(
      pgSchema.conversationParticipantsPostgres,
      expect.anything(),
    );
    expect(secondJoin).toHaveBeenCalledWith(
      pgSchema.conversationsPostgres,
      expect.anything(),
    );
    const predicate = where.mock.calls[0]?.[0];
    expect(flattenSqlShape(predicate)).toContain('person-111');
    expect(flattenSqlShape(predicate)).toContain('direct');
    expect(flattenSqlShape(predicate)).toContain('active');
    expect(flattenSqlShape(predicate)).toContain('retired_at');
  });

  it('reverts only a registered claim to a retryable prompt', async () => {
    const row = promptedRow();
    const returning = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const repository = new PostgresGroupJoinOnboardingRepository({
      update,
    } as never);

    await expect(
      repository.revertRegistered({
        id: 'opaque-2',
        now: '2026-07-18T01:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'prompted', registeredAt: null });

    expect(set).toHaveBeenCalledWith({
      status: 'prompted',
      registeredAt: null,
      updatedAt: '2026-07-18T01:00:00.000Z',
    });
    const predicate = where.mock.calls[0]?.[0];
    expect(flattenSqlShape(predicate)).toContain('opaque-2');
    expect(flattenSqlShape(predicate)).toContain('registered');
  });
});

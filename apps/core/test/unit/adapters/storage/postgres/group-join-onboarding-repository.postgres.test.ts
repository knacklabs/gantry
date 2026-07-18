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
  it('upserts one prompt per provider chat while preserving registered rows', async () => {
    const row = promptedRow();
    const returning = vi.fn(async () => [row]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const repository = new PostgresGroupJoinOnboardingRepository({
      insert,
    } as never);

    await expect(
      repository.recordPrompt({
        id: row.id,
        providerAccountId: row.providerAccountId,
        chatJid: row.chatJid,
        adder: row.adder,
        approver: row.approver,
        promptConversationJid: row.promptConversationJid,
        promptAgentFolder: row.promptAgentFolder,
        now: row.promptedAt,
      }),
    ).resolves.toEqual(row);

    expect(insert).toHaveBeenCalledWith(pgSchema.groupJoinOnboardingPostgres);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'prompted', id: 'opaque-2' }),
    );
    const conflict = onConflictDoUpdate.mock.calls[0]?.[0];
    expect(conflict?.target).toEqual([
      pgSchema.groupJoinOnboardingPostgres.providerAccountId,
      pgSchema.groupJoinOnboardingPostgres.chatJid,
    ]);
    expect(flattenSqlShape(conflict?.set.id)).toContain('registered');
    expect(flattenSqlShape(conflict?.set.status)).toContain('prompted');
  });

  it('dismisses only a currently prompted opaque request', async () => {
    const row = { ...promptedRow(), status: 'dismissed' };
    const returning = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const repository = new PostgresGroupJoinOnboardingRepository({
      update,
    } as never);

    await expect(
      repository.markDismissed({
        id: 'opaque-2',
        now: '2026-07-18T01:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'dismissed' });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dismissed',
        dismissedAt: '2026-07-18T01:00:00.000Z',
      }),
    );
    const predicate = where.mock.calls[0]?.[0];
    expect(flattenSqlShape(predicate)).toContain('opaque-2');
    expect(flattenSqlShape(predicate)).toContain('prompted');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { PostgresAuthenticationRepository } from '@core/adapters/storage/postgres/repositories/authentication-repository.postgres.js';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

describe('authentication repository', () => {
  it('keeps the generated migration snapshot aligned with the auth schema', () => {
    const snapshot = JSON.parse(
      fs.readFileSync(
        path.join(
          repoRoot,
          'apps/core/src/adapters/storage/postgres/schema/migrations/meta/20260818105732_snapshot.json',
        ),
        'utf8',
      ),
    ) as {
      tables: Record<string, { columns: Record<string, { notNull: boolean }> }>;
    };
    const tableNames = [
      'browser_sessions',
      'console_access_grants',
      'console_invitations',
      'local_authorization_codes',
      'oidc_transactions',
    ];

    for (const tableName of tableNames) {
      expect(snapshot.tables[`public.${tableName}`]).toBeDefined();
    }
    expect(
      snapshot.tables['public.local_authorization_codes']?.columns.user_id
        ?.notNull,
    ).toBe(true);
    expect(
      snapshot.tables['public.console_access_grants']?.columns.user_id?.notNull,
    ).toBe(true);
  });

  it.each([
    ['demotion', { role: 'viewer' }],
    ['disablement', { status: 'disabled' }],
    ['pending reset', { status: 'awaiting_approval' }],
  ] as const)('refuses final active administrator %s', async (_case, next) => {
    const rows = [
      [
        {
          id: 'grant-1',
          appId: 'default',
          userId: 'user-1',
          role: 'administrator',
          status: 'active',
        },
      ],
      [{ id: 'grant-1' }],
    ];
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            for: vi.fn(async () => rows.shift() ?? []),
          }),
        }),
      })),
      update: vi.fn(),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (executor: typeof tx) => Promise<boolean>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresAuthenticationRepository(db as never);

    await expect(
      repository.updateGrant(
        'default',
        'grant-1',
        next,
        '2026-08-19T00:00:00.000Z',
      ),
    ).resolves.toBe(false);
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('uses atomic one-use consumption and app-scoped administrator locks', () => {
    const source = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/adapters/storage/postgres/repositories/authentication-repository.postgres.ts',
      ),
      'utf8',
    );
    expect(source).toContain('.delete(schema.oidcTransactionsPostgres)');
    expect(source).toContain('new Date(row.expiresAt).getTime()');
    expect(source).toContain('localAuthorizationCodesPostgres.canonicalHost');
    expect(source).toContain("return 'wrong_host' as const");
    expect(source).toContain(".for('update')");
    expect(source).toContain('activeAdministrators.length <= 1');
    expect(source).toContain("existingGrant?.status === 'active'");
    expect(source).toContain('pg_advisory_xact_lock');
    expect(source).toContain('refreshAwaitingGrant');
    expect(source).toContain('reauthenticateSessionHash');
    expect(source).toContain('browserSessionsPostgres.revokedAt');
    expect(source).toContain('revokeInvitationById');
    expect(source).not.toContain('count(*)::int');
  });
});

it('authentication repository > records CLI recovery audit in the approval transaction', async () => {
  const grant = {
    id: 'grant-1',
    appId: 'default',
    userId: 'user-1',
    role: 'administrator',
    status: 'active',
  };
  const tx = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ for: vi.fn(async () => [grant]) }),
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({ returning: vi.fn(async () => [grant]) }),
      }),
    })),
  };
  const db = {
    transaction: vi.fn(
      async (operation: (executor: typeof tx) => Promise<unknown>) =>
        operation(tx),
    ),
  };
  const appendRuntimeEventWithExecutor = vi.fn(async () => undefined);
  const repository = new PostgresAuthenticationRepository(
    db as never,
    {
      appendRuntimeEventWithExecutor,
    } as never,
  );

  await expect(
    repository.approveAccessReference({
      accessReferenceHash: 'hash-only-reference',
      role: 'administrator',
      actor: 'cli:auth-access',
      now: '2026-08-20T00:00:00.000Z',
    }),
  ).resolves.toEqual(grant);
  expect(appendRuntimeEventWithExecutor).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      eventType: 'auth.access.recovered',
      actor: 'cli:auth-access',
      payload: { userId: 'user-1', role: 'administrator' },
    }),
  );
  expect(
    JSON.stringify(appendRuntimeEventWithExecutor.mock.calls),
  ).not.toContain('hash-only-reference');
});

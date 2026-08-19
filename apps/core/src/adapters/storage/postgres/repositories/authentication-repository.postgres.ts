import { randomUUID } from 'node:crypto';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type {
  ConsoleAccessStatus,
  ConsoleRole,
} from '../../../../application/auth/auth-foundations.js';
import * as schema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export class PostgresAuthenticationRepository {
  constructor(private readonly db: CanonicalDb) {}

  async createLocalAuthorizationCode(input: {
    appId: string;
    userId: string;
    tokenHash: string;
    canonicalHost: string;
    expiresAt: string;
    now: string;
  }): Promise<void> {
    await this.db.insert(schema.localAuthorizationCodesPostgres).values({
      id: randomUUID(),
      ...input,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async ensureLocalAdministrator(appId: string, now: string): Promise<string> {
    const userId = `local-console:${appId}`;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.usersPostgres)
        .values({
          id: userId,
          appId,
          kind: 'human',
          displayName: 'Local console',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      await tx
        .insert(schema.userAliasesPostgres)
        .values({
          id: `local-console-alias:${appId}`,
          appId,
          userId,
          provider: 'local_console',
          externalUserId: 'local',
          displayName: 'Local console',
          verificationStatus: 'verified',
          verifiedAt: now,
          verifiedBy: 'system:local',
          evidenceJson: { evidenceType: 'local_console' },
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      await tx
        .insert(schema.consoleAccessGrantsPostgres)
        .values({
          id: `local-console-grant:${appId}`,
          appId,
          userId,
          role: 'administrator',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    });
    return userId;
  }

  async consumeLocalAuthorizationCode(
    tokenHash: string,
    canonicalHost: string,
    now: string,
  ) {
    const [row] = await this.db
      .update(schema.localAuthorizationCodesPostgres)
      .set({ consumedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.localAuthorizationCodesPostgres.tokenHash, tokenHash),
          eq(
            schema.localAuthorizationCodesPostgres.canonicalHost,
            canonicalHost,
          ),
          isNull(schema.localAuthorizationCodesPostgres.consumedAt),
          gt(schema.localAuthorizationCodesPostgres.expiresAt, now),
        ),
      )
      .returning();
    return row ?? null;
  }

  async localAuthorizationCodeStatus(
    tokenHash: string,
    canonicalHost: string,
    now: string,
  ) {
    const [row] = await this.db
      .select({
        consumedAt: schema.localAuthorizationCodesPostgres.consumedAt,
        expiresAt: schema.localAuthorizationCodesPostgres.expiresAt,
        canonicalHost: schema.localAuthorizationCodesPostgres.canonicalHost,
      })
      .from(schema.localAuthorizationCodesPostgres)
      .where(eq(schema.localAuthorizationCodesPostgres.tokenHash, tokenHash))
      .limit(1);
    if (!row || new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
      return 'expired' as const;
    }
    if (row.canonicalHost !== canonicalHost) return 'wrong_host' as const;
    return row.consumedAt ? ('used' as const) : ('unknown' as const);
  }

  async createOidcTransaction(input: {
    id: string;
    appId: string;
    stateHash: string;
    nonceHash: string;
    encryptedPkceVerifier: string;
    oidcConfigJson?: string;
    configurationTest: boolean;
    invitationTokenHash?: string;
    reauthenticateUserId?: string;
    reauthenticateSessionHash?: string;
    expiresAt: string;
    now: string;
  }): Promise<void> {
    await this.db.insert(schema.oidcTransactionsPostgres).values({
      ...input,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async consumeOidcTransaction(stateHash: string, now: string) {
    const [row] = await this.db
      .delete(schema.oidcTransactionsPostgres)
      .where(
        and(
          eq(schema.oidcTransactionsPostgres.stateHash, stateHash),
          isNull(schema.oidcTransactionsPostgres.consumedAt),
        ),
      )
      .returning();
    if (!row || new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
      return null;
    }
    return row;
  }

  async createInvitation(input: {
    appId: string;
    tokenHash: string;
    invitedEmail: string;
    role: ConsoleRole;
    expiresAt: string;
    now: string;
  }): Promise<void> {
    await this.db.insert(schema.consoleInvitationsPostgres).values({
      id: randomUUID(),
      ...input,
      invitedEmail: input.invitedEmail.trim().toLowerCase(),
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async invitationStatus(tokenHash: string, now: string) {
    const [row] = await this.db
      .select()
      .from(schema.consoleInvitationsPostgres)
      .where(eq(schema.consoleInvitationsPostgres.tokenHash, tokenHash))
      .limit(1);
    if (!row || new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
      return { status: 'expired' as const };
    }
    if (row.consumedAt) return { status: 'used' as const };
    if (row.revokedAt) return { status: 'expired' as const };
    return {
      status: 'valid' as const,
      invitedEmail: row.invitedEmail,
      role: row.role as ConsoleRole,
    };
  }

  async acceptInvitation(input: {
    tokenHash: string;
    userId: string;
    verifiedEmail: string;
    now: string;
  }): Promise<
    | { status: 'accepted'; role: ConsoleRole }
    | { status: 'expired' | 'used' | 'mismatch' }
  > {
    return this.db.transaction(async (tx) => {
      const [invitation] = await tx
        .select()
        .from(schema.consoleInvitationsPostgres)
        .where(eq(schema.consoleInvitationsPostgres.tokenHash, input.tokenHash))
        .for('update');
      if (
        !invitation ||
        new Date(invitation.expiresAt).getTime() <=
          new Date(input.now).getTime()
      ) {
        return { status: 'expired' as const };
      }
      if (invitation.consumedAt) return { status: 'used' as const };
      if (invitation.revokedAt) return { status: 'expired' as const };
      if (
        invitation.invitedEmail !== input.verifiedEmail.trim().toLowerCase()
      ) {
        return { status: 'mismatch' as const };
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`console-access-grants:${invitation.appId}`}, 0))`,
      );
      const [existingGrant] = await tx
        .select()
        .from(schema.consoleAccessGrantsPostgres)
        .where(
          and(
            eq(schema.consoleAccessGrantsPostgres.appId, invitation.appId),
            eq(schema.consoleAccessGrantsPostgres.userId, input.userId),
          ),
        )
        .for('update');
      await tx
        .update(schema.consoleInvitationsPostgres)
        .set({ consumedAt: input.now, updatedAt: input.now })
        .where(eq(schema.consoleInvitationsPostgres.id, invitation.id));
      if (existingGrant?.status === 'active') {
        return {
          status: 'accepted' as const,
          role: existingGrant.role as ConsoleRole,
        };
      }
      if (existingGrant) {
        await tx
          .update(schema.consoleAccessGrantsPostgres)
          .set({
            role: invitation.role,
            status: 'active',
            updatedAt: input.now,
          })
          .where(eq(schema.consoleAccessGrantsPostgres.id, existingGrant.id));
        await tx
          .update(schema.browserSessionsPostgres)
          .set({ revokedAt: input.now, updatedAt: input.now })
          .where(
            and(
              eq(schema.browserSessionsPostgres.appId, invitation.appId),
              eq(schema.browserSessionsPostgres.userId, input.userId),
              isNull(schema.browserSessionsPostgres.revokedAt),
            ),
          );
      } else {
        await tx.insert(schema.consoleAccessGrantsPostgres).values({
          id: randomUUID(),
          appId: invitation.appId,
          userId: input.userId,
          role: invitation.role,
          status: 'active',
          createdAt: input.now,
          updatedAt: input.now,
        });
      }
      return {
        status: 'accepted' as const,
        role: invitation.role as ConsoleRole,
      };
    });
  }

  async getGrant(appId: string, userId: string) {
    const [grant] = await this.db
      .select()
      .from(schema.consoleAccessGrantsPostgres)
      .where(
        and(
          eq(schema.consoleAccessGrantsPostgres.appId, appId),
          eq(schema.consoleAccessGrantsPostgres.userId, userId),
        ),
      )
      .limit(1);
    return grant ?? null;
  }

  async createDomainViewerGrant(input: {
    appId: string;
    userId: string;
    now: string;
  }): Promise<void> {
    await this.db
      .insert(schema.consoleAccessGrantsPostgres)
      .values({
        id: randomUUID(),
        appId: input.appId,
        userId: input.userId,
        role: 'viewer',
        status: 'active',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing();
  }

  async createAwaitingGrant(input: {
    appId: string;
    userId: string;
    accessReferenceHash: string;
    accessReferenceExpiresAt: string;
    now: string;
  }): Promise<boolean> {
    const [grant] = await this.db
      .insert(schema.consoleAccessGrantsPostgres)
      .values({
        id: randomUUID(),
        appId: input.appId,
        userId: input.userId,
        role: 'viewer',
        status: 'awaiting_approval',
        accessReferenceHash: input.accessReferenceHash,
        accessReferenceExpiresAt: input.accessReferenceExpiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.consoleAccessGrantsPostgres.id });
    return grant !== undefined;
  }

  async refreshAwaitingGrant(input: {
    appId: string;
    userId: string;
    accessReferenceHash: string;
    accessReferenceExpiresAt: string;
    now: string;
  }): Promise<boolean> {
    const [grant] = await this.db
      .update(schema.consoleAccessGrantsPostgres)
      .set({
        accessReferenceHash: input.accessReferenceHash,
        accessReferenceExpiresAt: input.accessReferenceExpiresAt,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.consoleAccessGrantsPostgres.appId, input.appId),
          eq(schema.consoleAccessGrantsPostgres.userId, input.userId),
          eq(schema.consoleAccessGrantsPostgres.status, 'awaiting_approval'),
        ),
      )
      .returning({ id: schema.consoleAccessGrantsPostgres.id });
    return grant !== undefined;
  }

  async approveAccessReference(input: {
    accessReferenceHash: string;
    role: ConsoleRole;
    now: string;
  }) {
    return this.db.transaction(async (tx) => {
      const [grant] = await tx
        .select()
        .from(schema.consoleAccessGrantsPostgres)
        .where(
          and(
            eq(
              schema.consoleAccessGrantsPostgres.accessReferenceHash,
              input.accessReferenceHash,
            ),
            eq(schema.consoleAccessGrantsPostgres.status, 'awaiting_approval'),
            gt(
              schema.consoleAccessGrantsPostgres.accessReferenceExpiresAt,
              input.now,
            ),
          ),
        )
        .for('update');
      if (!grant) return null;
      const [updated] = await tx
        .update(schema.consoleAccessGrantsPostgres)
        .set({
          role: input.role,
          status: 'active',
          accessReferenceHash: null,
          accessReferenceExpiresAt: null,
          updatedAt: input.now,
        })
        .where(eq(schema.consoleAccessGrantsPostgres.id, grant.id))
        .returning();
      return updated ?? null;
    });
  }

  async getAwaitingAccessReference(accessReferenceHash: string, now: string) {
    const [grant] = await this.db
      .select({
        appId: schema.consoleAccessGrantsPostgres.appId,
        userId: schema.consoleAccessGrantsPostgres.userId,
        displayName: schema.usersPostgres.displayName,
      })
      .from(schema.consoleAccessGrantsPostgres)
      .innerJoin(
        schema.usersPostgres,
        eq(schema.usersPostgres.id, schema.consoleAccessGrantsPostgres.userId),
      )
      .where(
        and(
          eq(
            schema.consoleAccessGrantsPostgres.accessReferenceHash,
            accessReferenceHash,
          ),
          eq(schema.consoleAccessGrantsPostgres.status, 'awaiting_approval'),
          gt(schema.consoleAccessGrantsPostgres.accessReferenceExpiresAt, now),
        ),
      )
      .limit(1);
    if (!grant?.userId) return null;
    const aliases = await this.db
      .select({
        provider: schema.userAliasesPostgres.provider,
        providerAccountId: schema.userAliasesPostgres.providerAccountId,
        externalUserId: schema.userAliasesPostgres.externalUserId,
        verificationStatus: schema.userAliasesPostgres.verificationStatus,
      })
      .from(schema.userAliasesPostgres)
      .where(
        and(
          eq(schema.userAliasesPostgres.appId, grant.appId),
          eq(schema.userAliasesPostgres.userId, grant.userId),
          isNull(schema.userAliasesPostgres.retiredAt),
        ),
      );
    return { ...grant, aliases };
  }

  async listAccessGrants(appId: string) {
    return this.db
      .select({
        id: schema.consoleAccessGrantsPostgres.id,
        userId: schema.consoleAccessGrantsPostgres.userId,
        role: schema.consoleAccessGrantsPostgres.role,
        status: schema.consoleAccessGrantsPostgres.status,
        displayName: schema.usersPostgres.displayName,
        updatedAt: schema.consoleAccessGrantsPostgres.updatedAt,
      })
      .from(schema.consoleAccessGrantsPostgres)
      .leftJoin(
        schema.usersPostgres,
        eq(schema.usersPostgres.id, schema.consoleAccessGrantsPostgres.userId),
      )
      .where(eq(schema.consoleAccessGrantsPostgres.appId, appId));
  }

  async listInvitations(appId: string) {
    return this.db
      .select({
        id: schema.consoleInvitationsPostgres.id,
        invitedEmail: schema.consoleInvitationsPostgres.invitedEmail,
        role: schema.consoleInvitationsPostgres.role,
        createdAt: schema.consoleInvitationsPostgres.createdAt,
        expiresAt: schema.consoleInvitationsPostgres.expiresAt,
      })
      .from(schema.consoleInvitationsPostgres)
      .where(
        and(
          eq(schema.consoleInvitationsPostgres.appId, appId),
          isNull(schema.consoleInvitationsPostgres.consumedAt),
          isNull(schema.consoleInvitationsPostgres.revokedAt),
        ),
      );
  }

  async revokeInvitationById(input: {
    id: string;
    appId: string;
    actor: string;
    now: string;
  }): Promise<boolean> {
    const [invitation] = await this.db
      .update(schema.consoleInvitationsPostgres)
      .set({ revokedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(schema.consoleInvitationsPostgres.id, input.id),
          eq(schema.consoleInvitationsPostgres.appId, input.appId),
          isNull(schema.consoleInvitationsPostgres.consumedAt),
          isNull(schema.consoleInvitationsPostgres.revokedAt),
        ),
      )
      .returning({ id: schema.consoleInvitationsPostgres.id });
    return invitation !== undefined;
  }

  async listBrowserSessions(appId: string, userId: string) {
    return this.db
      .select({
        id: schema.browserSessionsPostgres.id,
        createdAt: schema.browserSessionsPostgres.createdAt,
        lastActiveAt: schema.browserSessionsPostgres.updatedAt,
        idleExpiresAt: schema.browserSessionsPostgres.idleExpiresAt,
        absoluteExpiresAt: schema.browserSessionsPostgres.absoluteExpiresAt,
        revokedAt: schema.browserSessionsPostgres.revokedAt,
      })
      .from(schema.browserSessionsPostgres)
      .where(
        and(
          eq(schema.browserSessionsPostgres.appId, appId),
          eq(schema.browserSessionsPostgres.userId, userId),
        ),
      );
  }

  async revokeSessionById(input: {
    id: string;
    appId: string;
    userId: string;
    now: string;
  }): Promise<boolean> {
    const [row] = await this.db
      .update(schema.browserSessionsPostgres)
      .set({ revokedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(schema.browserSessionsPostgres.id, input.id),
          eq(schema.browserSessionsPostgres.appId, input.appId),
          eq(schema.browserSessionsPostgres.userId, input.userId),
          isNull(schema.browserSessionsPostgres.revokedAt),
        ),
      )
      .returning({ id: schema.browserSessionsPostgres.id });
    return row !== undefined;
  }

  async revokeSession(sessionHash: string, now: string): Promise<boolean> {
    const [row] = await this.db
      .update(schema.browserSessionsPostgres)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.browserSessionsPostgres.sessionHash, sessionHash),
          isNull(schema.browserSessionsPostgres.revokedAt),
        ),
      )
      .returning({ id: schema.browserSessionsPostgres.id });
    return row !== undefined;
  }

  async createBrowserSession(input: {
    appId: string;
    userId: string;
    sessionHash: string;
    csrfHash: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
    reauthenticatedAt?: string;
    now: string;
  }): Promise<void> {
    await this.db.insert(schema.browserSessionsPostgres).values({
      id: randomUUID(),
      ...input,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async getActiveSession(input: {
    sessionHash: string;
    now: string;
    nextIdleExpiresAt: string;
  }) {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          id: schema.browserSessionsPostgres.id,
          appId: schema.browserSessionsPostgres.appId,
          userId: schema.browserSessionsPostgres.userId,
          csrfHash: schema.browserSessionsPostgres.csrfHash,
          absoluteExpiresAt: schema.browserSessionsPostgres.absoluteExpiresAt,
          reauthenticatedAt: schema.browserSessionsPostgres.reauthenticatedAt,
          role: schema.consoleAccessGrantsPostgres.role,
          status: schema.consoleAccessGrantsPostgres.status,
          displayName: schema.usersPostgres.displayName,
        })
        .from(schema.browserSessionsPostgres)
        .innerJoin(
          schema.consoleAccessGrantsPostgres,
          and(
            eq(
              schema.consoleAccessGrantsPostgres.appId,
              schema.browserSessionsPostgres.appId,
            ),
            eq(
              schema.consoleAccessGrantsPostgres.userId,
              schema.browserSessionsPostgres.userId,
            ),
          ),
        )
        .innerJoin(
          schema.usersPostgres,
          eq(schema.usersPostgres.id, schema.browserSessionsPostgres.userId),
        )
        .where(
          and(
            eq(schema.browserSessionsPostgres.sessionHash, input.sessionHash),
            isNull(schema.browserSessionsPostgres.revokedAt),
            gt(schema.browserSessionsPostgres.idleExpiresAt, input.now),
            gt(schema.browserSessionsPostgres.absoluteExpiresAt, input.now),
          ),
        )
        .for('update');
      if (!session || session.status !== 'active') return null;
      await tx
        .update(schema.browserSessionsPostgres)
        .set({ updatedAt: input.now, idleExpiresAt: input.nextIdleExpiresAt })
        .where(eq(schema.browserSessionsPostgres.id, session.id));
      return session;
    });
  }

  async updateGrant(
    appId: string,
    grantId: string,
    next: { role?: ConsoleRole; status?: ConsoleAccessStatus },
    now: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`console-access-grants:${appId}`}, 0))`,
      );
      const [current] = await tx
        .select()
        .from(schema.consoleAccessGrantsPostgres)
        .where(
          and(
            eq(schema.consoleAccessGrantsPostgres.id, grantId),
            eq(schema.consoleAccessGrantsPostgres.appId, appId),
          ),
        )
        .for('update');
      if (!current) return false;
      const removesFinalAdmin =
        current.status === 'active' &&
        current.role === 'administrator' &&
        ((next.status !== undefined && next.status !== 'active') ||
          next.role === 'viewer');
      if (removesFinalAdmin) {
        const activeAdministrators = await tx
          .select({ id: schema.consoleAccessGrantsPostgres.id })
          .from(schema.consoleAccessGrantsPostgres)
          .where(
            and(
              eq(schema.consoleAccessGrantsPostgres.appId, current.appId),
              eq(schema.consoleAccessGrantsPostgres.status, 'active'),
              eq(schema.consoleAccessGrantsPostgres.role, 'administrator'),
            ),
          )
          .for('update');
        if (activeAdministrators.length <= 1) return false;
      }
      await tx
        .update(schema.consoleAccessGrantsPostgres)
        .set({ ...next, updatedAt: now })
        .where(
          and(
            eq(schema.consoleAccessGrantsPostgres.id, grantId),
            eq(schema.consoleAccessGrantsPostgres.appId, appId),
          ),
        );
      if (
        current.userId &&
        ((next.status !== undefined && next.status !== 'active') ||
          (next.role === 'administrator' && current.role !== 'administrator'))
      ) {
        await tx
          .update(schema.browserSessionsPostgres)
          .set({ revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.browserSessionsPostgres.appId, current.appId),
              eq(schema.browserSessionsPostgres.userId, current.userId),
              isNull(schema.browserSessionsPostgres.revokedAt),
            ),
          );
      }
      return true;
    });
  }
}

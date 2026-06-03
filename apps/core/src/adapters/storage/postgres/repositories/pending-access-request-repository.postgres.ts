import { and, eq, gt, sql } from 'drizzle-orm';

import type { AppId } from '../../../../domain/app/app.js';
import type { PendingAccessRequestsRepository } from '../../../../domain/ports/repositories.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

// A pending request is only counted while unexpired. This bounds the lifetime
// of a row whose approval never resolves (e.g. the runtime crashed mid-prompt)
// so it can never permanently inflate the needs-approval count — no sweeper.
const PENDING_ACCESS_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

function expiryFrom(nowIsoString: string): string {
  return new Date(
    Date.parse(nowIsoString) + PENDING_ACCESS_REQUEST_TTL_MS,
  ).toISOString();
}

export class PostgresPendingAccessRequestsRepository implements PendingAccessRequestsRepository {
  constructor(private readonly db: CanonicalDb) {}

  async insertPending(input: {
    id: string;
    appId: AppId;
    agentId: string;
    requestedBy: string;
    target: unknown;
    now?: string;
  }): Promise<void> {
    const now = input.now ?? nowIso();
    const expiresAt = expiryFrom(now);
    await this.db
      .insert(pgSchema.pendingAccessRequestsPostgres)
      .values({
        id: input.id,
        appId: input.appId,
        agentId: input.agentId,
        requestedBy: input.requestedBy,
        targetJson: JSON.stringify(input.target ?? {}),
        status: 'pending',
        createdAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.pendingAccessRequestsPostgres.id,
        set: {
          status: 'pending',
          resolvedAt: null,
          createdAt: now,
          expiresAt,
        },
      });
  }

  async markResolved(input: {
    appId: AppId;
    id: string;
    resolution: 'approved' | 'denied';
    now?: string;
  }): Promise<void> {
    const now = input.now ?? nowIso();
    await this.db
      .update(pgSchema.pendingAccessRequestsPostgres)
      .set({ status: input.resolution, resolvedAt: now })
      .where(
        and(
          eq(pgSchema.pendingAccessRequestsPostgres.appId, input.appId),
          eq(pgSchema.pendingAccessRequestsPostgres.id, input.id),
        ),
      );
  }

  async countPendingAccessRequests(input: { appId: AppId }): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(pgSchema.pendingAccessRequestsPostgres)
      .where(
        and(
          eq(pgSchema.pendingAccessRequestsPostgres.appId, input.appId),
          eq(pgSchema.pendingAccessRequestsPostgres.status, 'pending'),
          gt(pgSchema.pendingAccessRequestsPostgres.expiresAt, sql`now()`),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }
}

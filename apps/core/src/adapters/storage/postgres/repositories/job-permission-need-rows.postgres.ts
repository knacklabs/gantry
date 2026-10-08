import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import { settledOnceNeedIds } from '../../../../domain/job-permission-card-history.js';
import type { JobPermissionDurabilityState } from '../../../../domain/ports/job-permission-durability.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

// Writes every loaded need. A settled once-need leaves the pending set, so
// later per-job loads skip it.
export async function writeJobPermissionNeedRows(
  tx: CanonicalExecutor,
  appId: string,
  state: JobPermissionDurabilityState,
): Promise<void> {
  const table = pgSchema.pendingInteractionsPostgres;
  const settled = settledOnceNeedIds(state);
  for (const need of state.needs) {
    await tx
      .insert(table)
      .values({
        id: need.id,
        appId: appId,
        runId: null,
        envelopeId: null,
        memberIndex: null,
        sourceAgentFolder: need.sourceAgentFolder,
        requestId: need.id,
        runLeaseToken: null,
        runLeaseFencingVersion: null,
        kind: 'job_permission_need',
        status: settled.has(need.id) ? 'resolved' : 'pending',
        payloadJson: need,
        callbackRouteJson: null,
        idempotencyKey: need.id,
        approverRef: need.decidedBy,
        resolutionJson: null,
        createdAt: need.createdAt,
        expiresAt: '9999-12-31T23:59:59.999Z',
        resolvedAt: settled.has(need.id) ? sql`now()` : null,
      })
      .onConflictDoUpdate({
        target: table.idempotencyKey,
        set: {
          payloadJson: need,
          sourceAgentFolder: need.sourceAgentFolder,
          approverRef: need.decidedBy,
          status: settled.has(need.id) ? 'resolved' : 'pending',
          resolvedAt: settled.has(need.id)
            ? sql`COALESCE(${table.resolvedAt}, now())`
            : null,
        },
        setWhere: and(
          eq(table.appId, appId),
          eq(table.kind, 'job_permission_need'),
        ),
      });
  }
  // Settled needs are kept 30 days for late taps and replayed requests.
  // The sweep runs only when a need settles, so ordinary writes skip it.
  if (settled.size > 0) {
    await tx.delete(table).where(
      inArray(
        table.id,
        tx
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              eq(table.appId, appId),
              eq(table.status, 'resolved'),
              eq(table.kind, 'job_permission_need'),
              lt(table.resolvedAt, sql`now() - interval '30 days'`),
            ),
          )
          .limit(100),
      ),
    );
  }
}

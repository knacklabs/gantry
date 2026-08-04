import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { toMemoryReview } from './app-memory-review-record.js';
import { withStatementTimeout } from './app-memory-service-query-helpers.js';
import type {
  MemoryReviewRecord,
  NormalizedMemorySubject,
} from './memory-types.js';

type Db = NodePgDatabase<typeof pgSchema>;
type MemoryReviewRow =
  typeof pgSchema.memoryReviewRequestsPostgres.$inferSelect;

/**
 * Full immutable detail for one review: the parsed snapshot (both claims,
 * proposedCanonical, and every cited evidence row with untruncated text +
 * sourceUri). Scoped to the same appId/subject boundary as the pending page.
 * Returns null when the id is outside the caller's subject boundary.
 */
export async function getMemoryReviewDetail(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  reviewId: string;
  statementTimeoutMs?: number;
}): Promise<MemoryReviewRecord | null> {
  const rows = (await withStatementTimeout(
    input.db,
    input.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (db) =>
      db
        .select()
        .from(pgSchema.memoryReviewRequestsPostgres)
        .where(
          and(
            eq(pgSchema.memoryReviewRequestsPostgres.id, input.reviewId),
            eq(
              pgSchema.memoryReviewRequestsPostgres.appId,
              input.subject.appId,
            ),
            eq(
              pgSchema.memoryReviewRequestsPostgres.agentId,
              input.subject.agentId,
            ),
            eq(
              pgSchema.memoryReviewRequestsPostgres.subjectType,
              input.subject.subjectType,
            ),
            eq(
              pgSchema.memoryReviewRequestsPostgres.subjectId,
              input.subject.subjectId,
            ),
          ),
        )
        .limit(1),
  )) as MemoryReviewRow[];
  return rows[0] ? toMemoryReview(rows[0]) : null;
}

/**
 * Look up one review by id within the app+agent boundary only — NOT the
 * caller's subject. Used by channel-action decisions where the approver who
 * clicks is not necessarily the review's subject owner: the review carries its
 * own subject, and authority is gated separately (same-channel approver). The
 * app+agent filter keeps an approver from deciding a review bound to a
 * different agent/channel. Returns null when the id is outside that boundary.
 */
export async function getMemoryReviewWithinAgentBoundary(input: {
  db: Db;
  appId: string;
  agentId: string;
  reviewId: string;
  statementTimeoutMs?: number;
}): Promise<MemoryReviewRecord | null> {
  const rows = (await withStatementTimeout(
    input.db,
    input.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (db) =>
      db
        .select()
        .from(pgSchema.memoryReviewRequestsPostgres)
        .where(
          and(
            eq(pgSchema.memoryReviewRequestsPostgres.id, input.reviewId),
            eq(pgSchema.memoryReviewRequestsPostgres.appId, input.appId),
            eq(pgSchema.memoryReviewRequestsPostgres.agentId, input.agentId),
          ),
        )
        .limit(1),
  )) as MemoryReviewRow[];
  return rows[0] ? toMemoryReview(rows[0]) : null;
}

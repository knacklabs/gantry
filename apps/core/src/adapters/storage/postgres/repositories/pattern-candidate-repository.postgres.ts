import type {
  PatternCandidate,
  PatternCandidateStatus,
  PatternEvidenceRef,
  PatternProposalStatus,
} from '@gantry/contracts';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';

import type {
  PatternCandidateRepository,
  PatternCandidateSubject,
  PatternCandidateTransition,
} from '../../../../domain/ports/pattern-candidates.js';
import {
  PATTERN_SUGGESTED_FOLLOWUP_HOURS,
  PATTERN_VALUE_FLOOR_MIN_OCCURRENCES,
  PATTERN_VALUE_FLOOR_MIN_SPAN_DAYS,
} from '../../../../shared/pattern-candidate-policy.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const table = pgSchema.patternCandidatesPostgres;

/**
 * Reader for the runner + decision writer for the candidate decision service.
 * The detector/upsert writer (the dreaming pass) writes via direct db + schema
 * in the memory layer, so it is intentionally not implemented here.
 */
export class PostgresPatternCandidateRepository implements PatternCandidateRepository {
  constructor(private readonly db: CanonicalDb) {}

  async listEligible(input: {
    subject: PatternCandidateSubject;
    limit: number;
  }): Promise<PatternCandidate[]> {
    const { subject } = input;
    const suggestedSince = new Date(
      Date.now() - PATTERN_SUGGESTED_FOLLOWUP_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.appId, subject.appId),
          eq(table.agentId, subject.agentId),
          eq(table.subjectType, subject.subjectType),
          eq(table.subjectId, subject.subjectId),
          gte(table.occurrences, PATTERN_VALUE_FLOOR_MIN_OCCURRENCES),
          sql`${table.windowEnd}::timestamptz - ${table.windowStart}::timestamptz >= make_interval(days => ${PATTERN_VALUE_FLOOR_MIN_SPAN_DAYS})`,
          or(
            eq(table.candidateStatus, 'detected'),
            and(
              eq(table.candidateStatus, 'suggested'),
              gte(table.updatedAt, suggestedSince),
            ),
          ),
        ),
      )
      .orderBy(desc(table.occurrences), desc(table.lastDetectedAt))
      .limit(Math.min(Math.max(input.limit, 1), 20));
    return rows.map(mapRow);
  }

  async getById(id: string): Promise<PatternCandidate | null> {
    const [row] = await this.db
      .select()
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async transition(input: {
    id: string;
    transition: PatternCandidateTransition;
    nowIso: string;
  }): Promise<PatternCandidate | null> {
    const set: Partial<typeof table.$inferInsert> = {
      candidateStatus: input.transition.candidateStatus,
      updatedAt: input.nowIso,
    };
    if (input.transition.proposalStatus !== undefined) {
      set.proposalStatus = input.transition.proposalStatus;
    }
    if (input.transition.snoozedUntil !== undefined) {
      set.snoozedUntil = input.transition.snoozedUntil;
    }
    const allowedCurrentStatuses =
      input.transition.candidateStatus === 'suggested'
        ? ['detected']
        : ['detected', 'suggested'];
    const [row] = await this.db
      .update(table)
      .set(set)
      .where(
        and(
          eq(table.id, input.id),
          inArray(table.candidateStatus, allowedCurrentStatuses),
        ),
      )
      .returning();
    return row ? mapRow(row) : null;
  }

  async setProposalStatus(input: {
    id: string;
    proposalStatus: PatternProposalStatus;
    nowIso: string;
  }): Promise<PatternCandidate | null> {
    const [row] = await this.db
      .update(table)
      .set({
        proposalStatus: input.proposalStatus,
        updatedAt: input.nowIso,
      })
      .where(and(eq(table.id, input.id), eq(table.candidateStatus, 'accepted')))
      .returning();
    return row ? mapRow(row) : null;
  }
}

function mapRow(row: typeof table.$inferSelect): PatternCandidate {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    folder: row.folder,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    signature: row.signature,
    outcomeLabel: row.outcomeLabel,
    shortAsk: row.shortAsk,
    occurrences: row.occurrences,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    lastDetectedAt: row.lastDetectedAt,
    candidateStatus: row.candidateStatus as PatternCandidateStatus,
    proposalStatus:
      (row.proposalStatus as PatternProposalStatus | null) ?? null,
    snoozedUntil: row.snoozedUntil ?? null,
    evidenceRefs: Array.isArray(row.evidenceRefsJson)
      ? (row.evidenceRefsJson as PatternEvidenceRef[])
      : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

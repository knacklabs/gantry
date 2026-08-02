import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, } from 'drizzle-orm/pg-core';
import { appsPostgres } from './apps.js';
/**
 * Pattern candidates: repeated work the daily memory job detected, surfaced to
 * the agent so it can propose a durable skill in conversation. Deliberately
 * separate from `memory_items` (different lifecycle, higher blast radius).
 *
 * Three writers, no overlap: the dreaming detection pass upserts by `signature`;
 * a host-owned candidate decision service writes live user decisions; the runner
 * is read-only. Unique index on (app, agent, subject, signature) is
 * unconditional so a `dismissed` row persists and blocks re-creation.
 */
export const patternCandidatesPostgres = pgTable('pattern_candidates', {
    id: text('id').primaryKey(),
    appId: text('app_id')
        .notNull()
        .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    folder: text('folder').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    signature: text('signature').notNull(),
    outcomeLabel: text('outcome_label').notNull(),
    shortAsk: text('short_ask').notNull(),
    occurrences: integer('occurrences').notNull(),
    windowStart: timestamp('window_start', {
        withTimezone: true,
        mode: 'string',
    }).notNull(),
    windowEnd: timestamp('window_end', {
        withTimezone: true,
        mode: 'string',
    }).notNull(),
    lastDetectedAt: timestamp('last_detected_at', {
        withTimezone: true,
        mode: 'string',
    }).notNull(),
    candidateStatus: text('candidate_status').notNull().default('detected'),
    proposalStatus: text('proposal_status'),
    snoozedUntil: timestamp('snoozed_until', {
        withTimezone: true,
        mode: 'string',
    }),
    evidenceRefsJson: jsonb('evidence_refs')
        .notNull()
        .default(sql `'[]'::jsonb`),
    createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'string',
    }).notNull(),
}, (table) => ({
    signatureUnique: uniqueIndex('pattern_candidates_signature_unique').on(table.appId, table.agentId, table.subjectType, table.subjectId, table.signature),
    eligibleIdx: index('idx_pattern_candidates_eligible').on(table.appId, table.agentId, table.subjectType, table.subjectId, table.candidateStatus),
}));

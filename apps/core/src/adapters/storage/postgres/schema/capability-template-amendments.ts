import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';

export const capabilityTemplateAmendmentProposalsPostgres = pgTable(
  'capability_template_amendment_proposals',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    capabilityId: text('capability_id').notNull(),
    canonicalKey: text('canonical_key').notNull(),
    currentTemplates: jsonb('current_templates').$type<string[]>().notNull(),
    proposedTemplates: jsonb('proposed_templates').$type<string[]>().notNull(),
    observedArgv: jsonb('observed_argv').$type<string[]>().notNull(),
    reviewedSchemaHash: text('reviewed_schema_hash').notNull(),
    widening: boolean('widening').notNull(),
    status: text('status').notNull().default('pending'),
    requestedBy: text('requested_by').notNull(),
    // Routing context captured at proposal time so the approval card and the
    // fix-and-continue resume (stage 2) can reach the requester without a
    // second lookup: nullable because interactive requests carry no job.
    jobId: text('job_id'),
    conversationJid: text('conversation_jid'),
    threadId: text('thread_id'),
    decidedBy: text('decided_by'),
    decisionReason: text('decision_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => ({
    // Partial: one PENDING proposal per canonical command; terminal rows are
    // durable history, and a definition revision may supersede a terminal
    // decision with a new pending row (decision 0122).
    canonicalPendingUnique: uniqueIndex(
      'capability_template_amendment_proposals_canonical_unique',
    )
      .on(table.appId, table.canonicalKey)
      .where(sql`${table.status} = 'pending'`),
    statusIdx: index('idx_capability_template_amendment_proposals_status').on(
      table.appId,
      table.status,
      table.createdAt,
    ),
    statusCheck: check(
      'capability_template_amendment_proposals_status_check',
      sql`${table.status} IN ('pending', 'approved', 'denied')`,
    ),
  }),
);

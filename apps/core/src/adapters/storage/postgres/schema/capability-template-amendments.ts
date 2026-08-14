import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import { permissionAuditEventsPostgres } from './permissions.js';

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
    providerAccountId: text('provider_account_id'),
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

export const capabilityTemplateAmendmentHistoryPostgres = pgTable(
  'capability_template_amendment_history',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    proposalId: text('proposal_id')
      .notNull()
      // History follows its proposal: agent deletion cascades proposals, and
      // the definition-change audit trail lives in permission_audit_events.
      .references(() => capabilityTemplateAmendmentProposalsPostgres.id, {
        onDelete: 'cascade',
      }),
    capabilityId: text('capability_id').notNull(),
    priorTemplates: jsonb('prior_templates').$type<string[]>().notNull(),
    amendedTemplates: jsonb('amended_templates').$type<string[]>().notNull(),
    approvedBy: text('approved_by').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      // Both tables cascade with their app; RESTRICT here can abort app
      // deletion depending on cascade order. History follows its audit event.
      .references(() => permissionAuditEventsPostgres.id, {
        onDelete: 'cascade',
      }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    proposalUnique: uniqueIndex(
      'capability_template_amendment_history_proposal_unique',
    ).on(table.proposalId),
  }),
);

export const capabilityTemplateApprovalIntentsPostgres = pgTable(
  'capability_template_approval_intents',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => capabilityTemplateAmendmentProposalsPostgres.id, {
        onDelete: 'cascade',
      }),
    capabilityId: text('capability_id').notNull(),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    claimToken: text('claim_token'),
    claimExpiresAt: timestamp('claim_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    lastError: text('last_error'),
    approvedAt: timestamp('approved_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    proposalUnique: uniqueIndex(
      'capability_template_approval_intents_proposal_unique',
    ).on(table.proposalId),
    dueIdx: index('idx_capability_template_approval_intents_due').on(
      table.status,
      table.nextAttemptAt,
    ),
    statusCheck: check(
      'capability_template_approval_intents_status_check',
      sql`${table.status} IN ('pending', 'completed', 'superseded')`,
    ),
  }),
);

export const capabilityTemplateApprovalIntentTargetsPostgres = pgTable(
  'capability_template_approval_intent_targets',
  {
    intentId: text('intent_id')
      .notNull()
      .references(() => capabilityTemplateApprovalIntentsPostgres.id, {
        onDelete: 'cascade',
      }),
    // Intentionally no jobs FK: a deleted target must remain as durable
    // evidence until recovery closes it as superseded.
    jobId: text('job_id').notNull(),
    expectedSetupFingerprint: text('expected_setup_fingerprint').notNull(),
    status: text('status').notNull().default('pending'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.intentId, table.jobId] }),
    pendingIdx: index('idx_capability_template_approval_targets_pending').on(
      table.intentId,
      table.status,
    ),
    statusCheck: check(
      'capability_template_approval_intent_targets_status_check',
      sql`${table.status} IN ('pending', 'resumed', 'superseded')`,
    ),
  }),
);

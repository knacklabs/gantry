import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import { conversationsPostgres } from './conversations.js';
import { messagesPostgres } from './messages.js';

export const onboardingVerificationsPostgres = pgTable(
  'onboarding_verifications',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull().references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull().references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull().references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    challenge: text('challenge').notNull(),
    status: text('status').notNull().default('pending'),
    inboundMessageId: text('inbound_message_id').references(() => messagesPostgres.id, { onDelete: 'set null' }),
    outboundMessageId: text('outbound_message_id').references(() => messagesPostgres.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => ({
    activeChallenge: uniqueIndex('onboarding_verifications_active_challenge_unique').on(table.appId, table.challenge),
    conversationStatus: index('idx_onboarding_verifications_conversation_status').on(table.conversationId, table.status),
  }),
);

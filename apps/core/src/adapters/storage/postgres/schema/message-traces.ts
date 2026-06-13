import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { messagesPostgres } from './messages.js';

/**
 * Per-reply latency trace, keyed 1:1 to the outbound reply message. Generic /
 * agent-agnostic: `timings_json` and `payloads_json` carry server/tool names as
 * data, never as columns. `timings_json` is always written; `payloads_json` is
 * only populated when GANTRY_TRACE_PAYLOADS=1.
 */
export const messageTracesPostgres = pgTable(
  'message_traces',
  {
    messageId: text('message_id')
      .primaryKey()
      .references(() => messagesPostgres.id, { onDelete: 'cascade' }),
    appId: text('app_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    kind: text('kind').notNull(),
    totalMs: integer('total_ms').notNull(),
    timingsJson: jsonb('timings_json').notNull(),
    payloadsJson: jsonb('payloads_json'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    conversationIdx: index('message_traces_conversation_id_idx').on(
      table.conversationId,
    ),
  }),
);

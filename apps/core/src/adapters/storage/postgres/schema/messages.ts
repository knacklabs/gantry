import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';
import { channelInstallationsPostgres } from './channels.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';

export const messagesPostgres = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    channelProvider: text('channel_provider').notNull(),
    channelInstallationId: text('channel_installation_id')
      .notNull()
      .references(() => channelInstallationsPostgres.id, {
        onDelete: 'cascade',
      }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
      { onDelete: 'cascade' },
    ),
    externalMessageId: text('external_message_id'),
    externalRefJson: text('external_ref_json'),
    direction: text('direction').notNull(),
    senderUserId: text('sender_user_id'),
    senderDisplayName: text('sender_display_name'),
    trust: text('trust').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    receivedAt: timestamp('received_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    conversationCursorIdx: index('idx_messages_conversation_cursor').on(
      table.conversationId,
      table.threadId,
      table.createdAt,
      table.id,
    ),
    redeliveryUnique: uniqueIndex('idx_messages_external_redelivery_unique')
      .on(
        table.channelProvider,
        table.channelInstallationId,
        table.conversationId,
        table.threadId,
        table.externalMessageId,
      )
      .where(sql`${table.externalMessageId} IS NOT NULL`),
  }),
);

export const messagePartsPostgres = pgTable(
  'message_parts',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messagesPostgres.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => ({
    messageOrdinal: unique('message_parts_message_id_ordinal_unique').on(
      table.messageId,
      table.ordinal,
    ),
  }),
);

export const messageAttachmentsPostgres = pgTable('message_attachments', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messagesPostgres.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  externalRefJson: text('external_ref_json'),
  storageRef: text('storage_ref'),
  trust: text('trust').notNull(),
});

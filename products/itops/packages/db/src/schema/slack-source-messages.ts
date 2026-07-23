import { pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const slackSourceMessages = pgTable(
  "slack_source_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 50 }).default("slack").notNull(),
    workspaceId: varchar("workspace_id", { length: 100 }).notNull(),
    channelId: varchar("channel_id", { length: 100 }).notNull(),
    messageTs: varchar("message_ts", { length: 100 }).notNull(),
    threadTs: varchar("thread_ts", { length: 100 }),
    senderExternalUserId: varchar("sender_external_user_id", { length: 150 }),
    rawText: text("raw_text").notNull(),
    detectedType: varchar("detected_type", { length: 100 }).notNull(),
    processedStatus: varchar("processed_status", { length: 80 }).default("received").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    sourceMessageUnique: uniqueIndex("slack_source_messages_provider_workspace_channel_message_unique").on(
      table.provider,
      table.workspaceId,
      table.channelId,
      table.messageTs
    )
  })
);

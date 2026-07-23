import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const EMAIL_MESSAGE_STATUS = {
  pending: "pending",
  sending: "sending",
  sent: "sent",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled"
} as const;

export const EMAIL_MESSAGE_STATUS_VALUES = Object.values(EMAIL_MESSAGE_STATUS) as [
  "pending",
  "sending",
  "sent",
  "failed",
  "skipped",
  "cancelled"
];

export const emailMessageStatus = pgEnum("email_message_status", EMAIL_MESSAGE_STATUS_VALUES);

export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    templateKey: varchar("template_key", { length: 120 }).notNull(),
    senderType: varchar("sender_type", { length: 80 }).notNull(),
    fromEmail: varchar("from_email", { length: 255 }).notNull(),
    toEmail: varchar("to_email", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    status: emailMessageStatus("status").default(EMAIL_MESSAGE_STATUS.pending).notNull(),
    provider: varchar("provider", { length: 80 }).notNull(),
    providerMessageId: text("provider_message_id"),
    relatedEntityType: varchar("related_entity_type", { length: 120 }),
    relatedEntityId: uuid("related_entity_id"),
    errorMessage: text("error_message"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("email_messages_idempotency_key_unique").on(table.idempotencyKey),
    statusIdx: index("email_messages_status_idx").on(table.status),
    templateKeyIdx: index("email_messages_template_key_idx").on(table.templateKey),
    relatedEntityIdx: index("email_messages_related_entity_idx").on(table.relatedEntityType, table.relatedEntityId),
    toEmailIdx: index("email_messages_to_email_idx").on(table.toEmail),
    createdAtIdx: index("email_messages_created_at_idx").on(table.createdAt)
  })
);

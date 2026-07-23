import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const AUDIT_ACTOR = {
  system: "system"
} as const;

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorExternalUserId: text("actor_external_user_id").notNull(),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    entityType: varchar("entity_type", { length: 120 }).notNull(),
    entityId: uuid("entity_id"),
    beforeJson: jsonb("before_json").$type<Record<string, unknown>>(),
    afterJson: jsonb("after_json").$type<Record<string, unknown>>(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    eventTypeIdx: index("audit_events_event_type_idx").on(table.eventType),
    entityTypeEntityIdIdx: index("audit_events_entity_type_entity_id_idx").on(table.entityType, table.entityId),
    actorExternalUserIdIdx: index("audit_events_actor_external_user_id_idx").on(table.actorExternalUserId),
    createdAtIdx: index("audit_events_created_at_idx").on(table.createdAt)
  })
);

import { pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { systems } from "./systems.js";

export const ACCESS_RESOURCE_KEY = {
  companyEmail: "company_email",
  workspaceMembership: "workspace_membership"
} as const;

export const ACCESS_RESOURCE_TYPE = {
  account: "account",
  channel: "channel",
  workspace: "workspace"
} as const;

export const accessResources = pgTable(
  "access_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    systemId: uuid("system_id")
      .notNull()
      .references(() => systems.id),
    key: varchar("key", { length: 120 }).notNull(),
    name: varchar("name", { length: 180 }).notNull(),
    resourceType: varchar("resource_type", { length: 80 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    systemKeyUnique: uniqueIndex("access_resources_system_id_key_unique").on(table.systemId, table.key)
  })
);

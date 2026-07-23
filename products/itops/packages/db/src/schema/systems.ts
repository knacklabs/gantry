import { pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const SYSTEM_KEY = {
  googleWorkspace: "google_workspace",
  slack: "slack"
} as const;

export const SYSTEM_STATUS = {
  active: "active",
  inactive: "inactive"
} as const;

export const SYSTEM_STATUS_VALUES = Object.values(SYSTEM_STATUS) as ["active", "inactive"];

export const systemStatus = pgEnum("system_status", SYSTEM_STATUS_VALUES);

export const systems = pgTable("systems", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 80 }).notNull().unique(),
  name: varchar("name", { length: 180 }).notNull(),
  status: systemStatus("status").default(SYSTEM_STATUS.active).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

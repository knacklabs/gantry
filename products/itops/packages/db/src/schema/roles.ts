import { pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { systems } from "./systems.js";

export const ROLE_KEY = {
  user: "user",
  member: "member",
  channelManager: "channel_manager"
} as const;

export const ROLE_RISK_LEVEL = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical"
} as const;

export const ROLE_RISK_LEVEL_VALUES = Object.values(ROLE_RISK_LEVEL) as ["low", "medium", "high", "critical"];

export const roleRiskLevel = pgEnum("role_risk_level", ROLE_RISK_LEVEL_VALUES);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    systemId: uuid("system_id")
      .notNull()
      .references(() => systems.id),
    key: varchar("key", { length: 120 }).notNull(),
    name: varchar("name", { length: 180 }).notNull(),
    riskLevel: roleRiskLevel("risk_level").default(ROLE_RISK_LEVEL.medium).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    systemKeyUnique: uniqueIndex("roles_system_id_key_unique").on(table.systemId, table.key)
  })
);

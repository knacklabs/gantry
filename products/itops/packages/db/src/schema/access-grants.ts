import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accessResources } from "./access-resources.js";
import { employees } from "./employees.js";
import { roles } from "./roles.js";
import { systems } from "./systems.js";

export const ACCESS_GRANT_STATUS = {
  pending: "pending",
  active: "active",
  revocationPending: "revocation_pending",
  revoked: "revoked",
  failed: "failed",
  unknown: "unknown"
} as const;

export const ACCESS_GRANT_STATUS_VALUES = Object.values(ACCESS_GRANT_STATUS) as [
  "pending",
  "active",
  "revocation_pending",
  "revoked",
  "failed",
  "unknown"
];

export const accessGrantStatus = pgEnum("access_grant_status", ACCESS_GRANT_STATUS_VALUES);

export const accessGrants = pgTable(
  "access_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    systemId: uuid("system_id")
      .notNull()
      .references(() => systems.id),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => accessResources.id),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    status: accessGrantStatus("status").default(ACCESS_GRANT_STATUS.pending).notNull(),
    externalAccountId: text("external_account_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    employeeIdIdx: index("access_grants_employee_id_idx").on(table.employeeId),
    systemIdIdx: index("access_grants_system_id_idx").on(table.systemId),
    resourceIdIdx: index("access_grants_resource_id_idx").on(table.resourceId),
    roleIdIdx: index("access_grants_role_id_idx").on(table.roleId),
    statusIdx: index("access_grants_status_idx").on(table.status),
    employeeAccessUnique: uniqueIndex("access_grants_employee_system_resource_role_unique").on(
      table.employeeId,
      table.systemId,
      table.resourceId,
      table.roleId
    )
  })
);

import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { accessGrants } from "./access-grants.js";
import { accessRequests } from "./access-requests.js";
import { accessResources } from "./access-resources.js";
import { accessTasks } from "./access-tasks.js";
import { offboardingIntakes } from "./offboarding-intakes.js";
import { roles } from "./roles.js";
import { systems } from "./systems.js";

export const OFFBOARDING_REVOKE_ITEM_STATUS = {
  pending: "pending",
  taskCreated: "task_created",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled"
} as const;

export const OFFBOARDING_REVOKE_ITEM_STATUS_VALUES = Object.values(OFFBOARDING_REVOKE_ITEM_STATUS) as [
  "pending",
  "task_created",
  "completed",
  "failed",
  "skipped",
  "cancelled"
];

export const offboardingRevokeItems = pgTable(
  "offboarding_revoke_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offboardingIntakeId: uuid("offboarding_intake_id")
      .notNull()
      .references(() => offboardingIntakes.id),
    accessGrantId: uuid("access_grant_id")
      .notNull()
      .references(() => accessGrants.id),
    accessRequestId: uuid("access_request_id").references(() => accessRequests.id),
    accessTaskId: uuid("access_task_id").references(() => accessTasks.id),
    systemId: uuid("system_id")
      .notNull()
      .references(() => systems.id),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => accessResources.id),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    status: varchar("status", { length: 80 }).default(OFFBOARDING_REVOKE_ITEM_STATUS.pending).notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => ({
    offboardingIntakeIdIdx: index("offboarding_revoke_items_offboarding_intake_id_idx").on(
      table.offboardingIntakeId
    ),
    accessGrantIdIdx: index("offboarding_revoke_items_access_grant_id_idx").on(table.accessGrantId),
    accessRequestIdIdx: index("offboarding_revoke_items_access_request_id_idx").on(table.accessRequestId),
    accessTaskIdIdx: index("offboarding_revoke_items_access_task_id_idx").on(table.accessTaskId),
    statusIdx: index("offboarding_revoke_items_status_idx").on(table.status),
    intakeGrantUnique: uniqueIndex("offboarding_revoke_items_intake_grant_unique").on(
      table.offboardingIntakeId,
      table.accessGrantId
    )
  })
);

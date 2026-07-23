import { date, index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { employees } from "./employees.js";

export const OFFBOARDING_INTAKE_STATUS = {
  waitingForReview: "waiting_for_review",
  approved: "approved",
  rejected: "rejected",
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
} as const;

export const OFFBOARDING_INTAKE_STATUS_VALUES = Object.values(OFFBOARDING_INTAKE_STATUS) as [
  "waiting_for_review",
  "approved",
  "rejected",
  "in_progress",
  "completed",
  "failed",
  "cancelled"
];

export const offboardingIntakes = pgTable(
  "offboarding_intakes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    requestedByExternalUserId: text("requested_by_external_user_id").notNull(),
    reason: text("reason"),
    lastWorkingDay: date("last_working_day"),
    notes: text("notes"),
    status: varchar("status", { length: 80 }).default(OFFBOARDING_INTAKE_STATUS.waitingForReview).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => ({
    employeeIdIdx: index("offboarding_intakes_employee_id_idx").on(table.employeeId),
    statusIdx: index("offboarding_intakes_status_idx").on(table.status),
    requestedByExternalUserIdIdx: index("offboarding_intakes_requested_by_external_user_id_idx").on(
      table.requestedByExternalUserId
    ),
    createdAtIdx: index("offboarding_intakes_created_at_idx").on(table.createdAt)
  })
);

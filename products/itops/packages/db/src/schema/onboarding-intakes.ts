import { sql } from "drizzle-orm";
import { date, index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { accessRequests } from "./access-requests.js";
import { employees } from "./employees.js";
import { slackSourceMessages } from "./slack-source-messages.js";

export const ONBOARDING_INTAKE_STATUS = {
  received: "received",
  validationFailed: "validation_failed",
  waitingForReview: "waiting_for_review",
  approved: "approved",
  rejected: "rejected",
  readyForProvisioning: "ready_for_provisioning",
  completed: "completed",
  cancelled: "cancelled",
  superseded: "superseded"
} as const;

export const onboardingIntakes = pgTable(
  "onboarding_intakes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => slackSourceMessages.id),
    employeeId: uuid("employee_id").references(() => employees.id),
    googleWorkspaceAccessRequestId: uuid("google_workspace_access_request_id").references(() => accessRequests.id),
    name: varchar("name", { length: 255 }),
    personalEmail: varchar("personal_email", { length: 255 }),
    contactNo: varchar("contact_no", { length: 50 }),
    doj: date("doj"),
    employmentType: varchar("employment_type", { length: 50 }),
    designation: varchar("designation", { length: 180 }),
    laptop: varchar("laptop", { length: 120 }),
    relocation: varchar("relocation", { length: 120 }),
    requestedSlackChannels: jsonb("requested_slack_channels")
      .$type<unknown[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    validationErrors: jsonb("validation_errors")
      .$type<unknown[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    status: varchar("status", { length: 80 }).default(ONBOARDING_INTAKE_STATUS.received).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    sourceMessageIdIdx: index("onboarding_intakes_source_message_id_idx").on(table.sourceMessageId),
    employeeIdIdx: index("onboarding_intakes_employee_id_idx").on(table.employeeId),
    googleWorkspaceAccessRequestIdIdx: index("onboarding_intakes_google_workspace_access_request_id_idx").on(
      table.googleWorkspaceAccessRequestId
    ),
    statusIdx: index("onboarding_intakes_status_idx").on(table.status),
    personalEmailIdx: index("onboarding_intakes_personal_email_idx").on(table.personalEmail)
  })
);

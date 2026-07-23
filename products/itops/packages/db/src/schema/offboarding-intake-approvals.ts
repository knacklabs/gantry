import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { offboardingIntakes } from "./offboarding-intakes.js";

export const OFFBOARDING_INTAKE_APPROVAL_DECISION = {
  approved: "approved",
  rejected: "rejected"
} as const;

export const OFFBOARDING_INTAKE_APPROVAL_DECISION_VALUES = Object.values(
  OFFBOARDING_INTAKE_APPROVAL_DECISION
) as ["approved", "rejected"];

export const offboardingIntakeApprovals = pgTable(
  "offboarding_intake_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offboardingIntakeId: uuid("offboarding_intake_id")
      .notNull()
      .references(() => offboardingIntakes.id),
    approverExternalUserId: text("approver_external_user_id").notNull(),
    decision: varchar("decision", { length: 30 }).notNull(),
    comment: text("comment"),
    source: varchar("source", { length: 80 }).default("slack").notNull(),
    gantryConversationId: text("gantry_conversation_id"),
    gantryRuntimeEventId: text("gantry_runtime_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    offboardingIntakeIdIdx: index("offboarding_intake_approvals_offboarding_intake_id_idx").on(
      table.offboardingIntakeId
    ),
    approverExternalUserIdIdx: index("offboarding_intake_approvals_approver_external_user_id_idx").on(
      table.approverExternalUserId
    ),
    decisionIdx: index("offboarding_intake_approvals_decision_idx").on(table.decision)
  })
);

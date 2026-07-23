import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { onboardingIntakes } from "./onboarding-intakes.js";

export const ONBOARDING_INTAKE_APPROVAL_DECISION = {
  approved: "approved",
  rejected: "rejected"
} as const;

export const ONBOARDING_INTAKE_APPROVAL_DECISION_VALUES = Object.values(ONBOARDING_INTAKE_APPROVAL_DECISION) as [
  "approved",
  "rejected"
];

export const onboardingIntakeApprovals = pgTable(
  "onboarding_intake_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    onboardingIntakeId: uuid("onboarding_intake_id")
      .notNull()
      .references(() => onboardingIntakes.id),
    approverExternalUserId: text("approver_external_user_id").notNull(),
    decision: varchar("decision", { length: 30 }).notNull(),
    comment: text("comment"),
    source: varchar("source", { length: 80 }).default("slack").notNull(),
    gantryConversationId: text("gantry_conversation_id"),
    gantryRuntimeEventId: text("gantry_runtime_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    onboardingIntakeIdIdx: index("onboarding_intake_approvals_onboarding_intake_id_idx").on(
      table.onboardingIntakeId
    ),
    approverExternalUserIdIdx: index("onboarding_intake_approvals_approver_external_user_id_idx").on(
      table.approverExternalUserId
    ),
    decisionIdx: index("onboarding_intake_approvals_decision_idx").on(table.decision)
  })
);

import { index, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { accessRequests } from "./access-requests.js";

export const APPROVAL_DECISION = {
  approved: "approved",
  rejected: "rejected"
} as const;

export const APPROVAL_DECISION_VALUES = Object.values(APPROVAL_DECISION) as ["approved", "rejected"];

export const approvalDecision = pgEnum("approval_decision", APPROVAL_DECISION_VALUES);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accessRequestId: uuid("access_request_id")
      .notNull()
      .references(() => accessRequests.id),
    approverExternalUserId: text("approver_external_user_id").notNull(),
    decision: approvalDecision("decision").notNull(),
    comment: text("comment"),
    source: varchar("source", { length: 80 }).default("slack").notNull(),
    gantryConversationId: text("gantry_conversation_id"),
    gantryRuntimeEventId: text("gantry_runtime_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    accessRequestIdIdx: index("approvals_access_request_id_idx").on(table.accessRequestId),
    approverExternalUserIdIdx: index("approvals_approver_external_user_id_idx").on(table.approverExternalUserId)
  })
);

import { index, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { accessResources } from "./access-resources.js";
import { employees } from "./employees.js";
import { roles } from "./roles.js";
import { systems } from "./systems.js";

export const ACCESS_REQUEST_ACTION = {
  grant: "grant",
  revoke: "revoke"
} as const;

export const ACCESS_REQUEST_ACTION_VALUES = Object.values(ACCESS_REQUEST_ACTION) as [
  "grant",
  "revoke"
];

export const ACCESS_REQUEST_STATUS = {
  draft: "draft",
  waitingForApproval: "waiting_for_approval",
  approved: "approved",
  rejected: "rejected",
  provisioning: "provisioning",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
} as const;

export const ACCESS_REQUEST_STATUS_VALUES = Object.values(ACCESS_REQUEST_STATUS) as [
  "draft",
  "waiting_for_approval",
  "approved",
  "rejected",
  "provisioning",
  "completed",
  "failed",
  "cancelled"
];

export const OPEN_ACCESS_REQUEST_STATUSES = [
  ACCESS_REQUEST_STATUS.draft,
  ACCESS_REQUEST_STATUS.waitingForApproval,
  ACCESS_REQUEST_STATUS.approved,
  ACCESS_REQUEST_STATUS.provisioning
] as const;

export const accessRequestAction = pgEnum("access_request_action", ACCESS_REQUEST_ACTION_VALUES);

export const accessRequestStatus = pgEnum("access_request_status", ACCESS_REQUEST_STATUS_VALUES);

export const accessRequests = pgTable(
  "access_requests",
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
    action: accessRequestAction("action").notNull(),
    status: accessRequestStatus("status").default(ACCESS_REQUEST_STATUS.draft).notNull(),
    reason: text("reason"),
    requestedByExternalUserId: text("requested_by_external_user_id").notNull(),
    requestedFrom: varchar("requested_from", { length: 80 }),
    sourceConversationId: text("source_conversation_id"),
    sourceMessageId: text("source_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    employeeIdIdx: index("access_requests_employee_id_idx").on(table.employeeId),
    statusIdx: index("access_requests_status_idx").on(table.status),
    systemIdIdx: index("access_requests_system_id_idx").on(table.systemId),
    resourceIdIdx: index("access_requests_resource_id_idx").on(table.resourceId),
    roleIdIdx: index("access_requests_role_id_idx").on(table.roleId)
  })
);

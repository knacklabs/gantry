import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { accessRequests } from "./access-requests.js";

export const ACCESS_TASK_OPERATION = {
  grant: "grant",
  revoke: "revoke"
} as const;

export const ACCESS_TASK_OPERATION_VALUES = Object.values(ACCESS_TASK_OPERATION) as ["grant", "revoke"];

export const ACCESS_TASK_STATUS = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  retrying: "retrying",
  pendingDependency: "pending_dependency",
  skipped: "skipped",
  cancelled: "cancelled",
  pendingManual: "pending_manual"
} as const;

export const ACCESS_TASK_STATUS_VALUES = Object.values(ACCESS_TASK_STATUS) as [
  "pending",
  "running",
  "completed",
  "failed",
  "retrying",
  "pending_dependency",
  "skipped",
  "cancelled",
  "pending_manual"
];

export const accessTaskOperation = pgEnum("access_task_operation", ACCESS_TASK_OPERATION_VALUES);

export const accessTaskStatus = pgEnum("access_task_status", ACCESS_TASK_STATUS_VALUES);

export const accessTasks = pgTable(
  "access_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accessRequestId: uuid("access_request_id")
      .notNull()
      .references(() => accessRequests.id),
    operation: accessTaskOperation("operation").notNull(),
    connector: varchar("connector", { length: 120 }).notNull(),
    status: accessTaskStatus("status").default(ACCESS_TASK_STATUS.pending).notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    externalResultJson: jsonb("external_result_json").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    accessRequestIdIdx: index("access_tasks_access_request_id_idx").on(table.accessRequestId),
    statusIdx: index("access_tasks_status_idx").on(table.status),
    connectorIdx: index("access_tasks_connector_idx").on(table.connector),
    operationIdx: index("access_tasks_operation_idx").on(table.operation)
  })
);

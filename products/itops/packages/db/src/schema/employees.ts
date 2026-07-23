import { date, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const employmentType = pgEnum("employment_type", ["fte", "contractor"]);

export const EMPLOYEE_STATUS = {
  preboarding: "preboarding",
  active: "active",
  offboarding: "offboarding",
  offboarded: "offboarded"
} as const;

export const EMPLOYEE_STATUS_VALUES = Object.values(EMPLOYEE_STATUS) as [
  "preboarding",
  "active",
  "offboarding",
  "offboarded"
];

export const OPEN_EMPLOYEE_STATUSES = [
  EMPLOYEE_STATUS.preboarding,
  EMPLOYEE_STATUS.active,
  EMPLOYEE_STATUS.offboarding
] as const;

export const employeeStatus = pgEnum("employee_status", EMPLOYEE_STATUS_VALUES);

export const employees = pgTable("employees", {
  id: uuid("id").defaultRandom().primaryKey(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  workEmail: varchar("work_email", { length: 255 }).unique(),
  personalEmail: varchar("personal_email", { length: 255 }),
  contactNo: varchar("contact_no", { length: 50 }),
  employmentType: employmentType("employment_type").notNull(),
  designation: varchar("designation", { length: 180 }).notNull(),
  department: varchar("department", { length: 120 }),
  status: employeeStatus("status").default(EMPLOYEE_STATUS.preboarding).notNull(),
  startDate: date("start_date"),
  endDate: date("end_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

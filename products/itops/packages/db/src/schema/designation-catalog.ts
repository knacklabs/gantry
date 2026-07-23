import { boolean, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const designationCatalog = pgTable(
  "designation_catalog",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 180 }).notNull(),
    employmentType: varchar("employment_type", { length: 50 }).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    employmentTypeNameUnique: uniqueIndex("designation_catalog_employment_type_name_unique").on(
      table.employmentType,
      table.name
    )
  })
);

import { Injectable } from "@nestjs/common";
import { designationCatalog, employees } from "@itops/db";
import { and, eq, sql } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";

@Injectable()
export class OnboardingValidationRepository {
  constructor(private readonly databaseProvider: DatabaseProvider) {}

  async activeFteDesignationExists(designation: string): Promise<boolean> {
    const [row] = await this.databaseProvider.db
      .select({ id: designationCatalog.id })
      .from(designationCatalog)
      .where(
        and(
          eq(designationCatalog.employmentType, "fte"),
          eq(designationCatalog.active, true),
          sql`lower(${designationCatalog.name}) = ${designation.toLowerCase()}`
        )
      )
      .limit(1);

    return Boolean(row);
  }

  async employeePersonalEmailExists(personalEmail: string): Promise<boolean> {
    const [row] = await this.databaseProvider.db
      .select({ id: employees.id })
      .from(employees)
      .where(sql`lower(${employees.personalEmail}) = ${personalEmail.toLowerCase()}`)
      .limit(1);

    return Boolean(row);
  }

  async employeeWorkEmailExists(workEmail: string): Promise<boolean> {
    const [row] = await this.databaseProvider.db
      .select({ id: employees.id })
      .from(employees)
      .where(sql`lower(${employees.workEmail}) = ${workEmail.toLowerCase()}`)
      .limit(1);

    return Boolean(row);
  }

}

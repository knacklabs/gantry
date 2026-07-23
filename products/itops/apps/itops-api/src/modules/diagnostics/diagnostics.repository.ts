import { Injectable } from "@nestjs/common";
import {
  ACCESS_TASK_STATUS,
  accessRequests,
  accessResources,
  accessTasks,
  employees,
  roles,
  systems
} from "@itops/db";
import { desc, eq, ilike, or } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";

export type DiagnosticsAccessTaskRow = {
  accessTaskId: string;
  accessRequestId: string;
  status: string;
  operation: string;
  connector: string;
  attemptCount: number;
  errorMessage: string | null;
  externalResultJson: Record<string, unknown> | null;
  updatedAt: Date;
  employeeName: string;
  employeeWorkEmail: string | null;
  system: string;
  resource: string;
  role: string;
};

@Injectable()
export class DiagnosticsRepository {
  constructor(private readonly databaseProvider: DatabaseProvider) {}

  async listRecentFailedAccessTasks(limit = 10): Promise<DiagnosticsAccessTaskRow[]> {
    const rows = await this.baseTaskDetailsQuery()
      .where(eq(accessTasks.status, ACCESS_TASK_STATUS.failed))
      .orderBy(desc(accessTasks.updatedAt))
      .limit(limit);

    return rows.map(toDiagnosticsAccessTaskRow);
  }

  async listAccessTasksForEmployeeQuery(employeeQuery: string, limit = 20): Promise<DiagnosticsAccessTaskRow[]> {
    const pattern = `%${employeeQuery.trim()}%`;
    const rows = await this.baseTaskDetailsQuery()
      .where(or(ilike(employees.fullName, pattern), ilike(employees.workEmail, pattern)))
      .orderBy(desc(accessTasks.updatedAt))
      .limit(limit);

    return rows.map(toDiagnosticsAccessTaskRow);
  }

  private baseTaskDetailsQuery() {
    return this.databaseProvider.db
      .select({
        accessTask: accessTasks,
        employee: {
          fullName: employees.fullName,
          workEmail: employees.workEmail
        },
        system: {
          name: systems.name
        },
        resource: {
          name: accessResources.name
        },
        role: {
          name: roles.name
        }
      })
      .from(accessTasks)
      .innerJoin(accessRequests, eq(accessTasks.accessRequestId, accessRequests.id))
      .innerJoin(employees, eq(accessRequests.employeeId, employees.id))
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessRequests.roleId, roles.id));
  }
}

function toDiagnosticsAccessTaskRow(row: {
  accessTask: typeof accessTasks.$inferSelect;
  employee: { fullName: string; workEmail: string | null };
  system: { name: string };
  resource: { name: string };
  role: { name: string };
}): DiagnosticsAccessTaskRow {
  return {
    accessTaskId: row.accessTask.id,
    accessRequestId: row.accessTask.accessRequestId,
    status: row.accessTask.status,
    operation: row.accessTask.operation,
    connector: row.accessTask.connector,
    attemptCount: row.accessTask.attemptCount,
    errorMessage: row.accessTask.errorMessage,
    externalResultJson: row.accessTask.externalResultJson ?? null,
    updatedAt: row.accessTask.updatedAt,
    employeeName: row.employee.fullName,
    employeeWorkEmail: row.employee.workEmail,
    system: row.system.name,
    resource: row.resource.name,
    role: row.role.name
  };
}

import { Injectable } from "@nestjs/common";
import {
  ACCESS_GRANT_STATUS,
  accessGrants,
  accessRequests,
  accessResources,
  accessTasks,
  auditEvents,
  approvals,
  employees,
  offboardingIntakeApprovals,
  offboardingIntakes,
  OPEN_EMPLOYEE_STATUSES,
  roles,
  systems
} from "@itops/db";
import { and, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";
import type { CreateEmployeeInput } from "./dto/create-employee.dto.js";

export type Employee = typeof employees.$inferSelect;

export type EmployeeListStatus = "open" | "active" | "preboarding" | "offboarding" | "offboarded" | "all";

export type ListEmployeesRepositoryInput = {
  query?: string;
  status: EmployeeListStatus;
  page: number;
  pageSize: number;
};

export type ListEmployeesRepositoryResult = {
  employees: Employee[];
  page: number;
  pageSize: number;
  total: number;
  hasNextPage: boolean;
};

export type EmployeeAccessSummary = {
  employee: Pick<Employee, "id" | "fullName" | "workEmail" | "status">;
  access: Array<{
    grantId: string;
    system: {
      key: string;
      name: string;
    };
    resource: {
      key: string;
      name: string;
      resourceType: string;
    };
    role: {
      key: string;
      name: string;
      riskLevel: "low" | "medium" | "high" | "critical";
    };
    status: "active";
    externalAccountId: string | null;
    grantedAt: Date | null;
  }>;
};

export type AccessGrantSearchMode = "active" | "inactive" | "history";

export type AccessGrantSearchInput = {
  employeeQuery?: string;
  systemKey?: string;
  resourceKey?: string;
  status?: (typeof ACCESS_GRANT_STATUS)[keyof typeof ACCESS_GRANT_STATUS];
  mode?: AccessGrantSearchMode;
};

export type AccessGrantSearchResult = {
  grants: Array<{
    grantId: string;
    employee: Pick<Employee, "id" | "fullName" | "workEmail" | "status">;
    system: {
      key: string;
      name: string;
    };
    resource: {
      key: string;
      name: string;
      resourceType: string;
    };
    role: {
      key: string;
      name: string;
      riskLevel: "low" | "medium" | "high" | "critical";
    };
    status: (typeof ACCESS_GRANT_STATUS)[keyof typeof ACCESS_GRANT_STATUS];
    externalAccountId: string | null;
    grantedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
};

export type AccessDetailReportType = "offboarding_audit" | "access_history" | "revoke_task_status" | "access_request_status";

export type AccessDetailReportInput = {
  employeeQuery: string;
  reportType: AccessDetailReportType;
};

export type AccessDetailReport = {
  reportType: AccessDetailReportType;
  employees: Array<Pick<Employee, "id" | "fullName" | "workEmail" | "status">>;
  accessRequests: Array<{
    id: string;
    action: "grant" | "revoke";
    status: string;
    requestedFrom: string | null;
    requestedByExternalUserId: string;
    createdAt: Date;
    updatedAt: Date;
    system: { key: string; name: string };
    resource: { key: string; name: string; resourceType: string };
    role: { key: string; name: string };
  }>;
  approvals: Array<{
    id: string;
    accessRequestId: string;
    approverExternalUserId: string;
    decision: string;
    source: string;
    createdAt: Date;
  }>;
  accessTasks: Array<{
    id: string;
    accessRequestId: string;
    operation: "grant" | "revoke";
    status: string;
    connector: string;
    attemptCount: number;
    connectorResultSummary: Record<string, unknown> | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  accessGrants: Array<{
    id: string;
    employeeId: string;
    status: string;
    externalAccountId: string | null;
    grantedAt: Date | null;
    revokedAt: Date | null;
    system: { key: string; name: string };
    resource: { key: string; name: string; resourceType: string };
    role: { key: string; name: string };
  }>;
  offboardingIntakes: Array<{
    id: string;
    employeeId: string;
    status: string;
    requestedByExternalUserId: string;
    createdAt: Date;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    completedAt: Date | null;
  }>;
  offboardingApprovals: Array<{
    id: string;
    offboardingIntakeId: string;
    approverExternalUserId: string;
    decision: string;
    source: string;
    createdAt: Date;
  }>;
  auditEvents: Array<{
    id: string;
    eventType: string;
    entityType: string;
    entityId: string | null;
    actorExternalUserId: string;
    createdAt: Date;
  }>;
};

type CreateEmployeeRepositoryInput = Omit<CreateEmployeeInput, "createdByExternalUserId">;

@Injectable()
export class EmployeesRepository {
  constructor(private readonly databaseProvider: DatabaseProvider) {}

  async createEmployee(
    input: CreateEmployeeRepositoryInput,
    actorExternalUserId: string
  ): Promise<Employee> {
    const [createdEmployee] = await this.databaseProvider.db.transaction(async (tx) => {
      const [employee] = await tx
        .insert(employees)
        .values({
          fullName: input.fullName,
          personalEmail: input.personalEmail ?? null,
          workEmail: input.workEmail ?? null,
          employmentType: input.employmentType,
          designation: input.designation,
          department: input.department ?? null,
          startDate: input.startDate ?? null
        })
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId,
        eventType: "employee.created",
        entityType: "employee",
        entityId: employee.id,
        afterJson: employee
      });

      return [employee];
    });

    return createdEmployee;
  }

  async listEmployees(input: ListEmployeesRepositoryInput): Promise<ListEmployeesRepositoryResult> {
    const where = buildEmployeeListWhere(input);
    const offset = (input.page - 1) * input.pageSize;

    const [rows, totalRows] = await Promise.all([
      this.databaseProvider.db
        .select()
        .from(employees)
        .where(where)
        .orderBy(desc(employees.createdAt))
        .limit(input.pageSize)
        .offset(offset),
      this.databaseProvider.db
        .select({ value: count() })
        .from(employees)
        .where(where)
    ]);

    const total = totalRows[0]?.value ?? 0;

    return {
      employees: rows,
      page: input.page,
      pageSize: input.pageSize,
      total,
      hasNextPage: offset + rows.length < total
    };
  }

  async searchEmployees(query: string): Promise<Employee[]> {
    const pattern = `%${query}%`;

    return this.databaseProvider.db
      .select()
      .from(employees)
      .where(
        or(
          ilike(employees.fullName, pattern),
          ilike(employees.workEmail, pattern),
          ilike(employees.personalEmail, pattern)
        )
      )
      .orderBy(desc(employees.createdAt))
      .limit(20);
  }

  async findEmployeeById(id: string): Promise<Employee | undefined> {
    const [employee] = await this.databaseProvider.db.select().from(employees).where(eq(employees.id, id)).limit(1);
    return employee;
  }

  async findEmployeeByWorkEmail(email: string): Promise<Employee | undefined> {
    const [employee] = await this.databaseProvider.db.select().from(employees).where(eq(employees.workEmail, email)).limit(1);
    return employee;
  }

  async findPotentialDuplicateEmployee(input: {
    fullName: string;
    personalEmail: string;
    startDate: string;
  }): Promise<Employee | undefined> {
    const [employee] = await this.databaseProvider.db
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.fullName, input.fullName),
          eq(employees.personalEmail, input.personalEmail),
          eq(employees.startDate, input.startDate),
          inArray(employees.status, [...OPEN_EMPLOYEE_STATUSES])
        )
      )
      .limit(1);

    return employee;
  }

  async listActiveAccessForEmployee(employee: Employee): Promise<EmployeeAccessSummary> {
    const rows = await this.databaseProvider.db
      .select({
        grant: {
          id: accessGrants.id,
          status: accessGrants.status,
          externalAccountId: accessGrants.externalAccountId,
          grantedAt: accessGrants.grantedAt,
          createdAt: accessGrants.createdAt
        },
        system: {
          key: systems.key,
          name: systems.name
        },
        resource: {
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        }
      })
      .from(accessGrants)
      .innerJoin(systems, eq(accessGrants.systemId, systems.id))
      .innerJoin(accessResources, eq(accessGrants.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessGrants.roleId, roles.id))
      .where(and(eq(accessGrants.employeeId, employee.id), eq(accessGrants.status, ACCESS_GRANT_STATUS.active)))
      .orderBy(desc(accessGrants.grantedAt), desc(accessGrants.createdAt));

    return {
      employee: {
        id: employee.id,
        fullName: employee.fullName,
        workEmail: employee.workEmail,
        status: employee.status
      },
      access: rows.map((row) => ({
        grantId: row.grant.id,
        system: row.system,
        resource: row.resource,
        role: row.role,
        status: ACCESS_GRANT_STATUS.active,
        externalAccountId: row.grant.externalAccountId,
        grantedAt: row.grant.grantedAt
      }))
    };
  }

  async searchAccessGrants(input: AccessGrantSearchInput): Promise<AccessGrantSearchResult> {
    const filters = [];

    if (input.employeeQuery?.trim()) {
      const pattern = `%${input.employeeQuery.trim()}%`;
      filters.push(
        or(
          ilike(employees.fullName, pattern),
          ilike(employees.workEmail, pattern)
        )
      );
    }

    if (input.systemKey?.trim()) {
      filters.push(eq(systems.key, input.systemKey.trim()));
    }

    if (input.resourceKey?.trim()) {
      filters.push(eq(accessResources.key, input.resourceKey.trim()));
    }

    if (input.status) {
      filters.push(eq(accessGrants.status, input.status));
    } else if (input.mode === "active") {
      filters.push(eq(accessGrants.status, ACCESS_GRANT_STATUS.active));
    } else if (input.mode === "inactive") {
      filters.push(eq(accessGrants.status, ACCESS_GRANT_STATUS.revoked));
    }

    const rows = await this.databaseProvider.db
      .select({
        employee: {
          id: employees.id,
          fullName: employees.fullName,
          workEmail: employees.workEmail,
          status: employees.status
        },
        grant: {
          id: accessGrants.id,
          status: accessGrants.status,
          externalAccountId: accessGrants.externalAccountId,
          grantedAt: accessGrants.grantedAt,
          revokedAt: accessGrants.revokedAt,
          createdAt: accessGrants.createdAt,
          updatedAt: accessGrants.updatedAt
        },
        system: {
          key: systems.key,
          name: systems.name
        },
        resource: {
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        }
      })
      .from(accessGrants)
      .innerJoin(employees, eq(accessGrants.employeeId, employees.id))
      .innerJoin(systems, eq(accessGrants.systemId, systems.id))
      .innerJoin(accessResources, eq(accessGrants.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessGrants.roleId, roles.id))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(accessGrants.revokedAt), desc(accessGrants.grantedAt), desc(accessGrants.createdAt))
      .limit(50);

    return {
      grants: rows.map((row) => ({
        grantId: row.grant.id,
        employee: row.employee,
        system: row.system,
        resource: row.resource,
        role: row.role,
        status: row.grant.status,
        externalAccountId: row.grant.externalAccountId,
        grantedAt: row.grant.grantedAt,
        revokedAt: row.grant.revokedAt,
        createdAt: row.grant.createdAt,
        updatedAt: row.grant.updatedAt
      }))
    };
  }

  async getAccessDetailReport(input: AccessDetailReportInput): Promise<AccessDetailReport> {
    const employeeRows = await this.findEmployeesForDetailReport(input.employeeQuery);
    const employeeIds = employeeRows.map((employee) => employee.id);

    if (employeeIds.length === 0) {
      return emptyAccessDetailReport(input.reportType);
    }

    const [requestRows, grantRows, offboardingRows] = await Promise.all([
      this.listAccessRequestDetailsForEmployees(employeeIds),
      this.listAccessGrantDetailsForEmployees(employeeIds),
      this.listOffboardingIntakesForEmployees(employeeIds)
    ]);
    const accessRequestIds = requestRows.map((row) => row.id);
    const offboardingIntakeIds = offboardingRows.map((row) => row.id);

    const [approvalRows, taskRows, offboardingApprovalRows] = await Promise.all([
      accessRequestIds.length > 0 ? this.listApprovalsForAccessRequests(accessRequestIds) : [],
      accessRequestIds.length > 0 ? this.listAccessTasksForAccessRequests(accessRequestIds) : [],
      offboardingIntakeIds.length > 0 ? this.listOffboardingApprovals(offboardingIntakeIds) : []
    ]);

    const auditEntityIds = [
      ...employeeIds,
      ...accessRequestIds,
      ...approvalRows.map((row) => row.id),
      ...taskRows.map((row) => row.id),
      ...grantRows.map((row) => row.id),
      ...offboardingIntakeIds,
      ...offboardingApprovalRows.map((row) => row.id)
    ];
    const auditRows = auditEntityIds.length > 0 ? await this.listAuditEventsForEntities(auditEntityIds) : [];

    return {
      reportType: input.reportType,
      employees: employeeRows,
      accessRequests: requestRows,
      approvals: approvalRows,
      accessTasks: taskRows.map((task) => ({
        ...task,
        connectorResultSummary: sanitizeConnectorResult(task.connectorResultSummary)
      })),
      accessGrants: grantRows,
      offboardingIntakes: offboardingRows,
      offboardingApprovals: offboardingApprovalRows,
      auditEvents: auditRows
    };
  }

  private async findEmployeesForDetailReport(query: string): Promise<Array<Pick<Employee, "id" | "fullName" | "workEmail" | "status">>> {
    const trimmed = query.trim();
    const pattern = `%${trimmed}%`;

    return this.databaseProvider.db
      .select({
        id: employees.id,
        fullName: employees.fullName,
        workEmail: employees.workEmail,
        status: employees.status
      })
      .from(employees)
      .where(
        or(
          ilike(employees.fullName, pattern),
          ilike(employees.workEmail, pattern)
        )
      )
      .orderBy(desc(employees.createdAt))
      .limit(10);
  }

  private async listAccessRequestDetailsForEmployees(employeeIds: string[]): Promise<AccessDetailReport["accessRequests"]> {
    const rows = await this.databaseProvider.db
      .select({
        accessRequest: accessRequests,
        system: {
          key: systems.key,
          name: systems.name
        },
        resource: {
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          key: roles.key,
          name: roles.name
        }
      })
      .from(accessRequests)
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessRequests.roleId, roles.id))
      .where(inArray(accessRequests.employeeId, employeeIds))
      .orderBy(desc(accessRequests.createdAt))
      .limit(50);

    return rows.map((row) => ({
      id: row.accessRequest.id,
      action: row.accessRequest.action,
      status: row.accessRequest.status,
      requestedFrom: row.accessRequest.requestedFrom,
      requestedByExternalUserId: row.accessRequest.requestedByExternalUserId,
      createdAt: row.accessRequest.createdAt,
      updatedAt: row.accessRequest.updatedAt,
      system: row.system,
      resource: row.resource,
      role: row.role
    }));
  }

  private async listApprovalsForAccessRequests(accessRequestIds: string[]): Promise<AccessDetailReport["approvals"]> {
    return this.databaseProvider.db
      .select({
        id: approvals.id,
        accessRequestId: approvals.accessRequestId,
        approverExternalUserId: approvals.approverExternalUserId,
        decision: approvals.decision,
        source: approvals.source,
        createdAt: approvals.createdAt
      })
      .from(approvals)
      .where(inArray(approvals.accessRequestId, accessRequestIds))
      .orderBy(desc(approvals.createdAt))
      .limit(50);
  }

  private async listAccessTasksForAccessRequests(accessRequestIds: string[]): Promise<AccessDetailReport["accessTasks"]> {
    return this.databaseProvider.db
      .select({
        id: accessTasks.id,
        accessRequestId: accessTasks.accessRequestId,
        operation: accessTasks.operation,
        status: accessTasks.status,
        connector: accessTasks.connector,
        attemptCount: accessTasks.attemptCount,
        connectorResultSummary: accessTasks.externalResultJson,
        errorMessage: accessTasks.errorMessage,
        createdAt: accessTasks.createdAt,
        updatedAt: accessTasks.updatedAt
      })
      .from(accessTasks)
      .where(inArray(accessTasks.accessRequestId, accessRequestIds))
      .orderBy(desc(accessTasks.createdAt))
      .limit(50);
  }

  private async listAccessGrantDetailsForEmployees(employeeIds: string[]): Promise<AccessDetailReport["accessGrants"]> {
    const rows = await this.databaseProvider.db
      .select({
        grant: accessGrants,
        system: {
          key: systems.key,
          name: systems.name
        },
        resource: {
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          key: roles.key,
          name: roles.name
        }
      })
      .from(accessGrants)
      .innerJoin(systems, eq(accessGrants.systemId, systems.id))
      .innerJoin(accessResources, eq(accessGrants.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessGrants.roleId, roles.id))
      .where(inArray(accessGrants.employeeId, employeeIds))
      .orderBy(desc(accessGrants.revokedAt), desc(accessGrants.grantedAt), desc(accessGrants.createdAt))
      .limit(50);

    return rows.map((row) => ({
      id: row.grant.id,
      employeeId: row.grant.employeeId,
      status: row.grant.status,
      externalAccountId: row.grant.externalAccountId,
      grantedAt: row.grant.grantedAt,
      revokedAt: row.grant.revokedAt,
      system: row.system,
      resource: row.resource,
      role: row.role
    }));
  }

  private async listOffboardingIntakesForEmployees(employeeIds: string[]): Promise<AccessDetailReport["offboardingIntakes"]> {
    return this.databaseProvider.db
      .select({
        id: offboardingIntakes.id,
        employeeId: offboardingIntakes.employeeId,
        status: offboardingIntakes.status,
        requestedByExternalUserId: offboardingIntakes.requestedByExternalUserId,
        createdAt: offboardingIntakes.createdAt,
        approvedAt: offboardingIntakes.approvedAt,
        rejectedAt: offboardingIntakes.rejectedAt,
        completedAt: offboardingIntakes.completedAt
      })
      .from(offboardingIntakes)
      .where(inArray(offboardingIntakes.employeeId, employeeIds))
      .orderBy(desc(offboardingIntakes.createdAt))
      .limit(20);
  }

  private async listOffboardingApprovals(offboardingIntakeIds: string[]): Promise<AccessDetailReport["offboardingApprovals"]> {
    return this.databaseProvider.db
      .select({
        id: offboardingIntakeApprovals.id,
        offboardingIntakeId: offboardingIntakeApprovals.offboardingIntakeId,
        approverExternalUserId: offboardingIntakeApprovals.approverExternalUserId,
        decision: offboardingIntakeApprovals.decision,
        source: offboardingIntakeApprovals.source,
        createdAt: offboardingIntakeApprovals.createdAt
      })
      .from(offboardingIntakeApprovals)
      .where(inArray(offboardingIntakeApprovals.offboardingIntakeId, offboardingIntakeIds))
      .orderBy(desc(offboardingIntakeApprovals.createdAt))
      .limit(20);
  }

  private async listAuditEventsForEntities(entityIds: string[]): Promise<AccessDetailReport["auditEvents"]> {
    return this.databaseProvider.db
      .select({
        id: auditEvents.id,
        eventType: auditEvents.eventType,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        actorExternalUserId: auditEvents.actorExternalUserId,
        createdAt: auditEvents.createdAt
      })
      .from(auditEvents)
      .where(inArray(auditEvents.entityId, entityIds))
      .orderBy(desc(auditEvents.createdAt))
      .limit(100);
  }
}

function buildEmployeeListWhere(input: ListEmployeesRepositoryInput): SQL | undefined {
  const conditions: Array<SQL | undefined> = [];

  if (input.status === "open") {
    conditions.push(inArray(employees.status, [...OPEN_EMPLOYEE_STATUSES]));
  } else if (input.status !== "all") {
    conditions.push(eq(employees.status, input.status));
  }

  if (input.query) {
    const pattern = `%${input.query}%`;
    conditions.push(
      or(
        ilike(employees.fullName, pattern),
        ilike(employees.workEmail, pattern),
        ilike(employees.personalEmail, pattern)
      )
    );
  }

  return and(...conditions);
}

function emptyAccessDetailReport(reportType: AccessDetailReportType): AccessDetailReport {
  return {
    reportType,
    employees: [],
    accessRequests: [],
    approvals: [],
    accessTasks: [],
    accessGrants: [],
    offboardingIntakes: [],
    offboardingApprovals: [],
    auditEvents: []
  };
}

function sanitizeConnectorResult(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  const allowedKeys = [
    "provider",
    "operation",
    "mode",
    "status",
    "revoked",
    "suspended",
    "deactivated",
    "removed",
    "alreadyRemoved",
    "alreadyInactive",
    "alreadyMissing",
    "dryRun",
    "reason",
    "warning",
    "code"
  ];
  const summary: Record<string, unknown> = {};

  for (const key of allowedKeys) {
    const entry = value[key];
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      summary[key] = entry;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

import { Injectable } from "@nestjs/common";
import {
  ACCESS_REQUEST_STATUS,
  accessRequests,
  accessResources,
  accessTasks,
  auditEvents,
  employees,
  OPEN_ACCESS_REQUEST_STATUSES,
  roles,
  systems
} from "@itops/db";
import { and, desc, eq, inArray } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";
import type { CreateAccessRequestInput } from "./dto/create-access-request.dto.js";

export type EmployeeRecord = typeof employees.$inferSelect;
export type SystemRecord = typeof systems.$inferSelect;
export type AccessResourceRecord = typeof accessResources.$inferSelect;
export type RoleRecord = typeof roles.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
export type AccessTask = typeof accessTasks.$inferSelect;

export type AccessRequestDetail = AccessRequest & {
  employee: Pick<EmployeeRecord, "id" | "fullName" | "workEmail">;
  system: Pick<SystemRecord, "id" | "key" | "name">;
  resource: Pick<AccessResourceRecord, "id" | "key" | "name" | "resourceType">;
  role: Pick<RoleRecord, "id" | "key" | "name" | "riskLevel">;
};

type CreateAccessRequestRepositoryInput = Pick<CreateAccessRequestInput, "action" | "reason" | "requestedByExternalUserId" | "requestedFrom"> & {
  employeeId: string;
  systemId: string;
  resourceId: string;
  roleId: string;
};

@Injectable()
export class AccessRequestsRepository {
  constructor(private readonly databaseProvider: DatabaseProvider) {}

  async findEmployeeById(id: string): Promise<EmployeeRecord | undefined> {
    const [employee] = await this.databaseProvider.db.select().from(employees).where(eq(employees.id, id)).limit(1);
    return employee;
  }

  async findSystemByKey(key: string): Promise<SystemRecord | undefined> {
    const [system] = await this.databaseProvider.db.select().from(systems).where(eq(systems.key, key)).limit(1);
    return system;
  }

  async findResourceBySystemIdAndKey(systemId: string, key: string): Promise<AccessResourceRecord | undefined> {
    const [resource] = await this.databaseProvider.db
      .select()
      .from(accessResources)
      .where(and(eq(accessResources.systemId, systemId), eq(accessResources.key, key)))
      .limit(1);

    return resource;
  }

  async findRoleBySystemIdAndKey(systemId: string, key: string): Promise<RoleRecord | undefined> {
    const [role] = await this.databaseProvider.db
      .select()
      .from(roles)
      .where(and(eq(roles.systemId, systemId), eq(roles.key, key)))
      .limit(1);

    return role;
  }

  async findOpenAccessRequest(input: {
    employeeId: string;
    systemId: string;
    resourceId: string;
    roleId: string;
    action: "grant" | "revoke";
  }): Promise<AccessRequest | undefined> {
    const [accessRequest] = await this.databaseProvider.db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.employeeId, input.employeeId),
          eq(accessRequests.systemId, input.systemId),
          eq(accessRequests.resourceId, input.resourceId),
          eq(accessRequests.roleId, input.roleId),
          eq(accessRequests.action, input.action),
          inArray(accessRequests.status, [...OPEN_ACCESS_REQUEST_STATUSES])
        )
      )
      .limit(1);

    return accessRequest;
  }

  async createAccessRequest(input: CreateAccessRequestRepositoryInput): Promise<AccessRequest> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const [accessRequest] = await tx
        .insert(accessRequests)
        .values({
          employeeId: input.employeeId,
          systemId: input.systemId,
          resourceId: input.resourceId,
          roleId: input.roleId,
          action: input.action,
          status: ACCESS_REQUEST_STATUS.waitingForApproval,
          reason: input.reason ?? null,
          requestedByExternalUserId: input.requestedByExternalUserId,
          requestedFrom: input.requestedFrom ?? null
        })
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.requestedByExternalUserId,
        eventType: "access_request.created",
        entityType: "access_request",
        entityId: accessRequest.id,
        afterJson: accessRequest
      });

      return accessRequest;
    });
  }

  async findAccessRequestDetailById(id: string): Promise<AccessRequestDetail | undefined> {
    const [row] = await this.databaseProvider.db
      .select({
        accessRequest: accessRequests,
        employee: {
          id: employees.id,
          fullName: employees.fullName,
          workEmail: employees.workEmail
        },
        system: {
          id: systems.id,
          key: systems.key,
          name: systems.name
        },
        resource: {
          id: accessResources.id,
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          id: roles.id,
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        }
      })
      .from(accessRequests)
      .innerJoin(employees, eq(accessRequests.employeeId, employees.id))
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessRequests.roleId, roles.id))
      .where(eq(accessRequests.id, id))
      .limit(1);

    if (!row) {
      return undefined;
    }

    return {
      ...row.accessRequest,
      employee: row.employee,
      system: row.system,
      resource: row.resource,
      role: row.role
    };
  }

  async listAccessTasksByAccessRequestId(accessRequestId: string): Promise<AccessTask[]> {
    return this.databaseProvider.db
      .select()
      .from(accessTasks)
      .where(eq(accessTasks.accessRequestId, accessRequestId))
      .orderBy(desc(accessTasks.createdAt));
  }
}

import {
  ACCESS_GRANT_STATUS,
  ACCESS_REQUEST_STATUS,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_STATUS,
  accessGrants,
  accessRequests,
  accessTasks,
  auditEvents,
  EMPLOYEE_STATUS,
  ROLE_RISK_LEVEL,
  SYSTEM_STATUS
} from "@itops/db";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseProvider } from "../../database/database.provider.js";
import {
  AccessTasksRepository,
  type AccessGrant,
  type AccessRequest,
  type AccessResource,
  type AccessTask,
  type AccessTaskExecutionContext,
  type Employee,
  type Role,
  type SystemRecord
} from "./access-tasks.repository.js";

describe("AccessTasksRepository", () => {
  it("marks failed task execution and parent access request as failed", async () => {
    const failedTask = makeAccessTask({
      status: ACCESS_TASK_STATUS.failed,
      errorMessage: "Google Workspace permission denied.",
      externalResultJson: {
        provider: "google_workspace",
        ok: false,
        code: "permission_denied",
        message: "Google Workspace permission denied.",
        statusCode: 403
      }
    });
    const taskReturning = {
      returning: vi.fn(async () => [failedTask])
    };
    const taskWhere = {
      where: vi.fn(() => taskReturning)
    };
    const taskSet = {
      set: vi.fn(() => taskWhere)
    };
    const requestWhere = {
      where: vi.fn(async () => undefined)
    };
    const requestSet = {
      set: vi.fn(() => requestWhere)
    };
    const insertValues = vi.fn(async () => undefined);
    const tx = {
      update: vi.fn((table) => {
        if (table === accessTasks) {
          return taskSet;
        }

        if (table === accessRequests) {
          return requestSet;
        }

        throw new Error("Unexpected table update.");
      }),
      insert: vi.fn((table) => {
        expect(table).toBe(auditEvents);
        return {
          values: insertValues
        };
      })
    };
    const databaseProvider = {
      db: {
        transaction: vi.fn(async (callback) => callback(tx))
      }
    };
    const repository = new AccessTasksRepository(databaseProvider as unknown as DatabaseProvider);
    const externalResultJson = {
      provider: "google_workspace",
      ok: false,
      code: "permission_denied",
      message: "Google Workspace permission denied.",
      statusCode: 403
    };

    await expect(repository.markAccessTaskFailed({
      taskId: failedTask.id,
      accessRequestId: failedTask.accessRequestId,
      actorExternalUserId: "system",
      errorMessage: "Google Workspace permission denied.",
      externalResultJson
    })).resolves.toBe(failedTask);

    expect(taskSet.set).toHaveBeenCalledWith(expect.objectContaining({
      status: ACCESS_TASK_STATUS.failed,
      errorMessage: "Google Workspace permission denied.",
      externalResultJson
    }));
    expect(requestSet.set).toHaveBeenCalledWith(expect.objectContaining({
      status: ACCESS_REQUEST_STATUS.failed
    }));
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      actorExternalUserId: "system",
      eventType: "access_task.failed",
      entityType: "access_task",
      entityId: failedTask.id,
      afterJson: failedTask,
      metadataJson: {
        access_request_id: failedTask.accessRequestId
      }
    }));
  });

  it("mock-completes a Slack access task and activates the matching grant", async () => {
    const context = makeExecutionContext({
      task: makeAccessTask({
        connector: "slack",
        idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:backend-alerts:member"
      }),
      system: makeSystem({ key: "slack", name: "Slack" }),
      resource: makeAccessResource({ key: "backend-alerts", name: "#backend-alerts", resourceType: "channel" }),
      role: makeRole({ key: "member", name: "Member", riskLevel: ROLE_RISK_LEVEL.low })
    });
    const completedTask = makeAccessTask({
      ...context.task,
      status: ACCESS_TASK_STATUS.completed,
      externalResultJson: {
        manual: true
      }
    });
    const grant = makeAccessGrant({
      employeeId: context.accessRequest.employeeId,
      systemId: context.accessRequest.systemId,
      resourceId: context.accessRequest.resourceId,
      roleId: context.accessRequest.roleId,
      externalAccountId: "manual:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:backend-alerts"
    });
    const taskReturning = {
      returning: vi.fn(async () => [completedTask])
    };
    const taskWhere = {
      where: vi.fn(() => taskReturning)
    };
    const taskSet = {
      set: vi.fn(() => taskWhere)
    };
    const requestWhere = {
      where: vi.fn(async () => undefined)
    };
    const requestSet = {
      set: vi.fn(() => requestWhere)
    };
    const grantReturning = {
      returning: vi.fn(async () => [grant])
    };
    const grantConflict = {
      onConflictDoUpdate: vi.fn(() => grantReturning)
    };
    const grantValues = {
      values: vi.fn(() => grantConflict)
    };
    const auditValues = vi.fn(async () => undefined);
    const tx = {
      update: vi.fn((table) => {
        if (table === accessTasks) {
          return taskSet;
        }

        if (table === accessRequests) {
          return requestSet;
        }

        throw new Error("Unexpected table update.");
      }),
      insert: vi.fn((table) => {
        if (table === accessGrants) {
          return grantValues;
        }

        if (table === auditEvents) {
          return {
            values: auditValues
          };
        }

        throw new Error("Unexpected table insert.");
      })
    };
    const databaseProvider = {
      db: {
        transaction: vi.fn(async (callback) => callback(tx))
      }
    };
    const repository = new AccessTasksRepository(databaseProvider as unknown as DatabaseProvider);

    await expect(repository.mockCompleteAccessTask({
      context,
      completedByExternalUserId: "slack:U999",
      externalAccountId: "manual:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:backend-alerts",
      externalResult: {
        manual: true
      }
    })).resolves.toEqual({
      task: completedTask,
      grant
    });

    expect(taskSet.set).toHaveBeenCalledWith(expect.objectContaining({
      status: ACCESS_TASK_STATUS.completed,
      externalResultJson: {
        manual: true
      }
    }));
    expect(grantValues.values).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: context.accessRequest.employeeId,
      systemId: context.accessRequest.systemId,
      resourceId: context.accessRequest.resourceId,
      roleId: context.accessRequest.roleId,
      status: ACCESS_GRANT_STATUS.active,
      externalAccountId: "manual:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:backend-alerts"
    }));
    expect(requestSet.set).toHaveBeenCalledWith(expect.objectContaining({
      status: ACCESS_REQUEST_STATUS.completed
    }));
    expect(auditValues).toHaveBeenCalledWith([
      expect.objectContaining({
        actorExternalUserId: "slack:U999",
        eventType: "access_task.completed",
        entityType: "access_task",
        entityId: completedTask.id
      }),
      expect.objectContaining({
        actorExternalUserId: "slack:U999",
        eventType: "access_grant.activated",
        entityType: "access_grant",
        entityId: grant.id
      })
    ]);
  });

  it("returns completed Slack task result idempotently without writing duplicate audit events", async () => {
    const context = makeExecutionContext({
      task: makeAccessTask({
        connector: "slack",
        status: ACCESS_TASK_STATUS.completed,
        idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:backend-alerts:member"
      }),
      system: makeSystem({ key: "slack", name: "Slack" }),
      resource: makeAccessResource({ key: "backend-alerts", name: "#backend-alerts", resourceType: "channel" }),
      role: makeRole({ key: "member", name: "Member", riskLevel: ROLE_RISK_LEVEL.low })
    });
    const grant = makeAccessGrant({
      employeeId: context.accessRequest.employeeId,
      systemId: context.accessRequest.systemId,
      resourceId: context.accessRequest.resourceId,
      roleId: context.accessRequest.roleId,
      externalAccountId: "manual:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:backend-alerts"
    });
    const selectLimit = vi.fn(async () => [grant]);
    const selectWhere = {
      where: vi.fn(() => ({
        limit: selectLimit
      }))
    };
    const selectFrom = {
      from: vi.fn(() => selectWhere)
    };
    const tx = {
      select: vi.fn(() => selectFrom),
      update: vi.fn(),
      insert: vi.fn()
    };
    const databaseProvider = {
      db: {
        transaction: vi.fn(async (callback) => callback(tx))
      }
    };
    const repository = new AccessTasksRepository(databaseProvider as unknown as DatabaseProvider);

    await expect(repository.mockCompleteAccessTask({
      context,
      completedByExternalUserId: "slack:U999",
      externalAccountId: "manual:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:backend-alerts"
    })).resolves.toEqual({
      task: context.task,
      grant
    });

    expect(selectFrom.from).toHaveBeenCalledWith(accessGrants);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

function makeAccessTask(overrides: Partial<AccessTask> = {}): AccessTask {
  return {
    id: "a7f679c4-16eb-40cc-8b16-d45f86717bd7",
    accessRequestId: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
    operation: ACCESS_TASK_OPERATION.grant,
    connector: "google_workspace",
    status: ACCESS_TASK_STATUS.pendingManual,
    idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:google_workspace:company_email:user",
    attemptCount: 0,
    externalResultJson: null,
    errorMessage: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeAccessGrant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    id: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
    resourceId: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
    roleId: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
    status: ACCESS_GRANT_STATUS.active,
    externalAccountId: "riya.sharma@company.com",
    grantedAt: new Date("2026-06-01T00:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeExecutionContext(overrides: Partial<AccessTaskExecutionContext> = {}): AccessTaskExecutionContext {
  const task = overrides.task ?? makeAccessTask();
  const accessRequest = overrides.accessRequest ?? makeAccessRequest({ id: task.accessRequestId });

  return {
    task,
    accessRequest,
    employee: makeEmployee({ id: accessRequest.employeeId }),
    system: makeSystem({ id: accessRequest.systemId }),
    resource: makeAccessResource({ id: accessRequest.resourceId, systemId: accessRequest.systemId }),
    role: makeRole({ id: accessRequest.roleId, systemId: accessRequest.systemId }),
    ...overrides
  };
}

function makeAccessRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
    resourceId: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
    roleId: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
    action: "grant",
    status: ACCESS_REQUEST_STATUS.approved,
    reason: "Slack channel access requested during onboarding",
    requestedByExternalUserId: "slack:U123",
    requestedFrom: "onboarding_intake",
    sourceConversationId: null,
    sourceMessageId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    fullName: "Riya Sharma",
    workEmail: "riya.sharma@example.com",
    personalEmail: "riya.personal@example.com",
    contactNo: null,
    employmentType: "fte",
    designation: "Backend Engineer",
    department: "Engineering",
    status: EMPLOYEE_STATUS.preboarding,
    startDate: "2026-06-10",
    endDate: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeSystem(overrides: Partial<SystemRecord> = {}): SystemRecord {
  return {
    id: "2fef76f2-507f-4c88-babe-07a089fdc003",
    key: "google_workspace",
    name: "Google Workspace",
    status: SYSTEM_STATUS.active,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeAccessResource(overrides: Partial<AccessResource> = {}): AccessResource {
  return {
    id: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
    systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
    key: "company_email",
    name: "Company Email Account",
    resourceType: "account",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
    systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
    key: "user",
    name: "User",
    riskLevel: ROLE_RISK_LEVEL.medium,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

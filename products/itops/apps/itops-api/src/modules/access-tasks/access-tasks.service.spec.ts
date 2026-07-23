import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  ACCESS_GRANT_STATUS,
  ACCESS_RESOURCE_KEY,
  ACCESS_RESOURCE_TYPE,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_STATUS,
  EMPLOYEE_STATUS,
  ROLE_RISK_LEVEL,
  SYSTEM_STATUS
} from "@itops/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccessTasksRepository,
  type AccessRequest,
  type AccessGrant,
  type AccessResource,
  type AccessTask,
  type AccessTaskExecutionContext,
  type Employee,
  type MockCompleteAccessTaskResult,
  type Role,
  type SystemRecord
} from "./access-tasks.repository.js";
import { AccessTasksService } from "./access-tasks.service.js";

type AccessTasksRepositoryMock = {
  findExecutionContextByTaskId: ReturnType<typeof vi.fn>;
  mockCompleteAccessTask: ReturnType<typeof vi.fn>;
};

describe("AccessTasksService", () => {
  let repository: AccessTasksRepositoryMock;
  let service: AccessTasksService;

  beforeEach(() => {
    repository = {
      findExecutionContextByTaskId: vi.fn(),
      mockCompleteAccessTask: vi.fn()
    };

    service = new AccessTasksService(repository as unknown as AccessTasksRepository);
  });

  it("mock-completes an access task", async () => {
    const task = makeAccessTask();
    const context = makeExecutionContext({ task });
    const result = makeMockCompleteResult({
      task: makeAccessTask({
        status: ACCESS_TASK_STATUS.completed,
        externalResultJson: {
          mock: true,
          message: "Google Workspace user would be created here"
        }
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.mockCompleteAccessTask.mockResolvedValue(result);

    await expect(
      service.mockCompleteAccessTask(task.id, {
        completedByExternalUserId: "system",
        externalAccountId: "riya.sharma@company.com",
        externalResult: {
          mock: true,
          message: "Google Workspace user would be created here"
        }
      })
    ).resolves.toBe(result);

    expect(repository.mockCompleteAccessTask).toHaveBeenCalledWith({
      context,
      completedByExternalUserId: "system",
      externalAccountId: "riya.sharma@company.com",
      externalResult: {
        mock: true,
        message: "Google Workspace user would be created here"
      }
    });
  });

  it("returns the repository result idempotently for an already completed task", async () => {
    const task = makeAccessTask({ status: ACCESS_TASK_STATUS.completed });
    const context = makeExecutionContext({ task });
    const result = makeMockCompleteResult({ task });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.mockCompleteAccessTask.mockResolvedValue(result);

    await expect(
      service.mockCompleteAccessTask(task.id, {
        completedByExternalUserId: "system",
        externalAccountId: "riya.sharma@company.com"
      })
    ).resolves.toBe(result);

    expect(repository.mockCompleteAccessTask).toHaveBeenCalledWith({
      context,
      completedByExternalUserId: "system",
      externalAccountId: "riya.sharma@company.com"
    });
  });

  it("mock-completes a Slack access task with a generated manual external account id", async () => {
    const task = makeAccessTask({
      connector: "slack",
      idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:backend-alerts:member"
    });
    const context = makeExecutionContext({
      task,
      system: makeSystem({ key: "slack", name: "Slack" }),
      resource: makeAccessResource({ key: "backend-alerts", name: "#backend-alerts", resourceType: "channel" }),
      role: makeRole({ key: "member", name: "Member", riskLevel: ROLE_RISK_LEVEL.low })
    });
    const result = makeMockCompleteResult({
      task: makeAccessTask({ ...task, status: ACCESS_TASK_STATUS.completed }),
      grant: makeAccessGrant({
        externalAccountId: "manual:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:backend-alerts"
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.mockCompleteAccessTask.mockResolvedValue(result);

    await expect(
      service.mockCompleteAccessTask(task.id, {
        completedByExternalUserId: "slack:U999"
      })
    ).resolves.toBe(result);

    expect(repository.mockCompleteAccessTask).toHaveBeenCalledWith({
      context,
      completedByExternalUserId: "slack:U999",
      externalAccountId: "manual:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:backend-alerts",
      externalResult: undefined
    });
  });

  it("mock-completes a Slack workspace membership task with the workspace manual external account id", async () => {
    const task = makeAccessTask({
      connector: "slack",
      idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:workspace_membership:member"
    });
    const context = makeExecutionContext({
      task,
      system: makeSystem({ key: "slack", name: "Slack" }),
      resource: makeAccessResource({
        key: ACCESS_RESOURCE_KEY.workspaceMembership,
        name: "Slack Workspace Membership",
        resourceType: ACCESS_RESOURCE_TYPE.workspace
      }),
      role: makeRole({ key: "member", name: "Member", riskLevel: ROLE_RISK_LEVEL.low })
    });
    const result = makeMockCompleteResult({
      task: makeAccessTask({ ...task, status: ACCESS_TASK_STATUS.completed }),
      grant: makeAccessGrant({
        externalAccountId: "manual:slack-workspace:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe"
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.mockCompleteAccessTask.mockResolvedValue(result);

    await expect(
      service.mockCompleteAccessTask(task.id, {
        completedByExternalUserId: "slack:U999"
      })
    ).resolves.toBe(result);

    expect(repository.mockCompleteAccessTask).toHaveBeenCalledWith({
      context,
      completedByExternalUserId: "slack:U999",
      externalAccountId: "manual:slack-workspace:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
      externalResult: undefined
    });
  });

  it("returns not found for malformed and missing task ids", async () => {
    await expect(
      service.mockCompleteAccessTask("not-a-uuid", {
        completedByExternalUserId: "system",
        externalAccountId: "riya.sharma@company.com"
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findExecutionContextByTaskId).not.toHaveBeenCalled();

    repository.findExecutionContextByTaskId.mockResolvedValue(undefined);

    await expect(
      service.mockCompleteAccessTask("a7f679c4-16eb-40cc-8b16-d45f86717000", {
        completedByExternalUserId: "system",
        externalAccountId: "riya.sharma@company.com"
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.mockCompleteAccessTask).not.toHaveBeenCalled();
  });

  it("returns bad request for invalid payloads", async () => {
    await expect(
      service.mockCompleteAccessTask("a7f679c4-16eb-40cc-8b16-d45f86717bd7", {
        completedByExternalUserId: "",
        externalAccountId: ""
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.findExecutionContextByTaskId).not.toHaveBeenCalled();
    expect(repository.mockCompleteAccessTask).not.toHaveBeenCalled();
  });

  it("requires externalAccountId for non-Slack mock completion", async () => {
    repository.findExecutionContextByTaskId.mockResolvedValue(makeExecutionContext());

    await expect(
      service.mockCompleteAccessTask("a7f679c4-16eb-40cc-8b16-d45f86717bd7", {
        completedByExternalUserId: "system"
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.mockCompleteAccessTask).not.toHaveBeenCalled();
  });

  it("returns bad request for non-grant tasks", async () => {
    repository.findExecutionContextByTaskId.mockResolvedValue(makeExecutionContext({
      task: makeAccessTask({ operation: ACCESS_TASK_OPERATION.revoke })
    }));

    await expect(
      service.mockCompleteAccessTask("a7f679c4-16eb-40cc-8b16-d45f86717bd7", {
        completedByExternalUserId: "system",
        externalAccountId: "riya.sharma@company.com"
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.mockCompleteAccessTask).not.toHaveBeenCalled();
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

function makeMockCompleteResult(overrides: Partial<MockCompleteAccessTaskResult> = {}): MockCompleteAccessTaskResult {
  return {
    task: makeAccessTask({ status: ACCESS_TASK_STATUS.completed }),
    grant: makeAccessGrant(),
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
    status: "approved",
    reason: "Company email required for onboarding",
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

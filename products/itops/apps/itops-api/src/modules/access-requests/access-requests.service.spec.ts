import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import {
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_STATUS,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_STATUS,
  EMPLOYEE_STATUS,
  ROLE_RISK_LEVEL,
  SYSTEM_STATUS
} from "@itops/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AccessRequest,
  AccessRequestDetail,
  AccessRequestsRepository,
  AccessTask,
  AccessResourceRecord,
  EmployeeRecord,
  RoleRecord,
  SystemRecord
} from "./access-requests.repository.js";
import { AccessRequestsService } from "./access-requests.service.js";

type AccessRequestsRepositoryMock = {
  findEmployeeById: ReturnType<typeof vi.fn>;
  findSystemByKey: ReturnType<typeof vi.fn>;
  findResourceBySystemIdAndKey: ReturnType<typeof vi.fn>;
  findRoleBySystemIdAndKey: ReturnType<typeof vi.fn>;
  findOpenAccessRequest: ReturnType<typeof vi.fn>;
  createAccessRequest: ReturnType<typeof vi.fn>;
  findAccessRequestDetailById: ReturnType<typeof vi.fn>;
  listAccessTasksByAccessRequestId: ReturnType<typeof vi.fn>;
};

describe("AccessRequestsService", () => {
  let repository: AccessRequestsRepositoryMock;
  let service: AccessRequestsService;

  beforeEach(() => {
    repository = {
      findEmployeeById: vi.fn(),
      findSystemByKey: vi.fn(),
      findResourceBySystemIdAndKey: vi.fn(),
      findRoleBySystemIdAndKey: vi.fn(),
      findOpenAccessRequest: vi.fn(),
      createAccessRequest: vi.fn(),
      findAccessRequestDetailById: vi.fn(),
      listAccessTasksByAccessRequestId: vi.fn()
    };

    service = new AccessRequestsService(repository as unknown as AccessRequestsRepository);
  });

  it("creates a waiting-for-approval access request with resolved catalog ids", async () => {
    const employee = makeEmployee();
    const system = makeSystem();
    const resource = makeResource();
    const role = makeRole();
    const accessRequest = makeAccessRequest();

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.findSystemByKey.mockResolvedValue(system);
    repository.findResourceBySystemIdAndKey.mockResolvedValue(resource);
    repository.findRoleBySystemIdAndKey.mockResolvedValue(role);
    repository.findOpenAccessRequest.mockResolvedValue(undefined);
    repository.createAccessRequest.mockResolvedValue(accessRequest);

    await expect(
      service.createAccessRequest({
        employeeId: employee.id,
        systemKey: "google_workspace",
        resourceKey: "company_email",
        roleKey: "user",
        action: ACCESS_REQUEST_ACTION.grant,
        reason: "Create company email during onboarding",
        requestedByExternalUserId: "slack:U123",
        requestedFrom: "api"
      })
    ).resolves.toBe(accessRequest);

    expect(repository.createAccessRequest).toHaveBeenCalledWith({
      employeeId: employee.id,
      systemId: system.id,
      resourceId: resource.id,
      roleId: role.id,
      action: ACCESS_REQUEST_ACTION.grant,
      reason: "Create company email during onboarding",
      requestedByExternalUserId: "slack:U123",
      requestedFrom: "api"
    });
    expect(accessRequest.status).toBe(ACCESS_REQUEST_STATUS.waitingForApproval);
  });

  it("creates a standalone Slack revoke access request", async () => {
    const employee = makeEmployee();
    const system = makeSystem({
      key: "slack",
      name: "Slack"
    });
    const resource = makeResource({
      systemId: system.id,
      key: "workspace_membership",
      name: "Workspace Membership",
      resourceType: "workspace"
    });
    const role = makeRole({
      systemId: system.id,
      key: "member",
      name: "Member"
    });
    const accessRequest = makeAccessRequest({
      systemId: system.id,
      resourceId: resource.id,
      roleId: role.id,
      action: ACCESS_REQUEST_ACTION.revoke,
      reason: "Remove Slack access"
    });

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.findSystemByKey.mockResolvedValue(system);
    repository.findResourceBySystemIdAndKey.mockResolvedValue(resource);
    repository.findRoleBySystemIdAndKey.mockResolvedValue(role);
    repository.findOpenAccessRequest.mockResolvedValue(undefined);
    repository.createAccessRequest.mockResolvedValue(accessRequest);

    await expect(
      service.createAccessRequest({
        employeeId: employee.id,
        systemKey: "slack",
        resourceKey: "workspace_membership",
        roleKey: "member",
        action: ACCESS_REQUEST_ACTION.revoke,
        reason: "Remove Slack access",
        requestedByExternalUserId: "slack:U123",
        requestedFrom: "gantry"
      })
    ).resolves.toBe(accessRequest);

    expect(repository.createAccessRequest).toHaveBeenCalledWith({
      employeeId: employee.id,
      systemId: system.id,
      resourceId: resource.id,
      roleId: role.id,
      action: ACCESS_REQUEST_ACTION.revoke,
      reason: "Remove Slack access",
      requestedByExternalUserId: "slack:U123",
      requestedFrom: "gantry"
    });
  });

  it("blocks standalone Google Workspace company email revoke requests", async () => {
    repository.findEmployeeById.mockResolvedValue(makeEmployee());
    repository.findSystemByKey.mockResolvedValue(makeSystem());
    repository.findResourceBySystemIdAndKey.mockResolvedValue(makeResource());
    repository.findRoleBySystemIdAndKey.mockResolvedValue(makeRole());

    await expect(
      service.createAccessRequest({
        ...makeCreatePayload(),
        action: ACCESS_REQUEST_ACTION.revoke,
        reason: "Remove company email"
      })
    ).rejects.toMatchObject({
      response: {
        message: "Google Workspace company email revocation is only supported through offboarding."
      }
    });

    expect(repository.findOpenAccessRequest).not.toHaveBeenCalled();
    expect(repository.createAccessRequest).not.toHaveBeenCalled();
  });

  it("rejects invalid create payloads", async () => {
    await expect(
      service.createAccessRequest({
        employeeId: "not-a-uuid",
        systemKey: "",
        resourceKey: "company_email",
        roleKey: "user",
        action: ACCESS_REQUEST_ACTION.grant,
        requestedByExternalUserId: ""
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.createAccessRequest).not.toHaveBeenCalled();
  });

  it("returns not found when employee is missing", async () => {
    repository.findEmployeeById.mockResolvedValue(undefined);

    await expect(service.createAccessRequest(makeCreatePayload())).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.findSystemByKey).not.toHaveBeenCalled();
  });

  it("returns not found when system is missing", async () => {
    repository.findEmployeeById.mockResolvedValue(makeEmployee());
    repository.findSystemByKey.mockResolvedValue(undefined);

    await expect(service.createAccessRequest(makeCreatePayload())).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.findResourceBySystemIdAndKey).not.toHaveBeenCalled();
  });

  it("returns not found when resource is missing", async () => {
    repository.findEmployeeById.mockResolvedValue(makeEmployee());
    repository.findSystemByKey.mockResolvedValue(makeSystem());
    repository.findResourceBySystemIdAndKey.mockResolvedValue(undefined);

    await expect(service.createAccessRequest(makeCreatePayload())).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.findRoleBySystemIdAndKey).not.toHaveBeenCalled();
  });

  it("returns not found when role is missing", async () => {
    repository.findEmployeeById.mockResolvedValue(makeEmployee());
    repository.findSystemByKey.mockResolvedValue(makeSystem());
    repository.findResourceBySystemIdAndKey.mockResolvedValue(makeResource());
    repository.findRoleBySystemIdAndKey.mockResolvedValue(undefined);

    await expect(service.createAccessRequest(makeCreatePayload())).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.findOpenAccessRequest).not.toHaveBeenCalled();
  });

  it("rejects duplicate open access requests", async () => {
    repository.findEmployeeById.mockResolvedValue(makeEmployee());
    repository.findSystemByKey.mockResolvedValue(makeSystem());
    repository.findResourceBySystemIdAndKey.mockResolvedValue(makeResource());
    repository.findRoleBySystemIdAndKey.mockResolvedValue(makeRole());
    repository.findOpenAccessRequest.mockResolvedValue(makeAccessRequest());

    await expect(service.createAccessRequest(makeCreatePayload())).rejects.toBeInstanceOf(ConflictException);

    expect(repository.createAccessRequest).not.toHaveBeenCalled();
  });

  it("returns access request detail by id", async () => {
    const detail = makeAccessRequestDetail();
    repository.findAccessRequestDetailById.mockResolvedValue(detail);

    await expect(service.findAccessRequestById(detail.id)).resolves.toBe(detail);
  });

  it("returns not found for malformed and missing ids", async () => {
    await expect(service.findAccessRequestById("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findAccessRequestDetailById).not.toHaveBeenCalled();

    repository.findAccessRequestDetailById.mockResolvedValue(undefined);

    await expect(service.findAccessRequestById("0a6f04d5-b890-42c7-99e8-e10be81b6000")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("lists access tasks for an access request", async () => {
    const detail = makeAccessRequestDetail();
    const tasks = [makeAccessTask()];
    repository.findAccessRequestDetailById.mockResolvedValue(detail);
    repository.listAccessTasksByAccessRequestId.mockResolvedValue(tasks);

    await expect(service.listAccessTasksByAccessRequestId(detail.id)).resolves.toBe(tasks);

    expect(repository.listAccessTasksByAccessRequestId).toHaveBeenCalledWith(detail.id);
  });

  it("returns not found when listing tasks for malformed and missing access request ids", async () => {
    await expect(service.listAccessTasksByAccessRequestId("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.listAccessTasksByAccessRequestId).not.toHaveBeenCalled();

    repository.findAccessRequestDetailById.mockResolvedValue(undefined);

    await expect(service.listAccessTasksByAccessRequestId("0a6f04d5-b890-42c7-99e8-e10be81b6000")).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(repository.listAccessTasksByAccessRequestId).not.toHaveBeenCalled();
  });
});

function makeCreatePayload(): Record<string, unknown> {
  return {
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    systemKey: "google_workspace",
    resourceKey: "company_email",
    roleKey: "user",
    action: ACCESS_REQUEST_ACTION.grant,
    reason: "Create company email during onboarding",
    requestedByExternalUserId: "slack:U123",
    requestedFrom: "api"
  };
}

function makeEmployee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    id: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    fullName: "Riya Sharma",
    workEmail: null,
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

function makeResource(overrides: Partial<AccessResourceRecord> = {}): AccessResourceRecord {
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

function makeRole(overrides: Partial<RoleRecord> = {}): RoleRecord {
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

function makeAccessRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
    resourceId: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
    roleId: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
    action: ACCESS_REQUEST_ACTION.grant,
    status: ACCESS_REQUEST_STATUS.waitingForApproval,
    reason: "Create company email during onboarding",
    requestedByExternalUserId: "slack:U123",
    requestedFrom: "api",
    sourceConversationId: null,
    sourceMessageId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeAccessRequestDetail(overrides: Partial<AccessRequestDetail> = {}): AccessRequestDetail {
  return {
    ...makeAccessRequest(),
    employee: {
      id: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
      fullName: "Riya Sharma",
      workEmail: null
    },
    system: {
      id: "2fef76f2-507f-4c88-babe-07a089fdc003",
      key: "google_workspace",
      name: "Google Workspace"
    },
    resource: {
      id: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
      key: "company_email",
      name: "Company Email Account",
      resourceType: "account"
    },
    role: {
      id: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
      key: "user",
      name: "User",
      riskLevel: ROLE_RISK_LEVEL.medium
    },
    ...overrides
  };
}

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

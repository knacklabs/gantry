import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ACCESS_GRANT_STATUS, EMPLOYEE_STATUS, ROLE_RISK_LEVEL } from "@itops/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailReadService, SafeEmailMessage } from "../email/email-read.service.js";
import type { Employee, EmployeeAccessSummary, EmployeesRepository } from "./employees.repository.js";
import { EmployeesService } from "./employees.service.js";

type EmployeesRepositoryMock = {
  createEmployee: ReturnType<typeof vi.fn>;
  listEmployees: ReturnType<typeof vi.fn>;
  searchEmployees: ReturnType<typeof vi.fn>;
  findEmployeeById: ReturnType<typeof vi.fn>;
  findEmployeeByWorkEmail: ReturnType<typeof vi.fn>;
  findPotentialDuplicateEmployee: ReturnType<typeof vi.fn>;
  listActiveAccessForEmployee: ReturnType<typeof vi.fn>;
  searchAccessGrants: ReturnType<typeof vi.fn>;
  getAccessDetailReport: ReturnType<typeof vi.fn>;
};

type EmailReadServiceMock = {
  listEmployeeEmails: ReturnType<typeof vi.fn>;
};

describe("EmployeesService", () => {
  let repository: EmployeesRepositoryMock;
  let emailReadService: EmailReadServiceMock;
  let service: EmployeesService;

  beforeEach(() => {
    repository = {
      createEmployee: vi.fn(),
      listEmployees: vi.fn(),
      searchEmployees: vi.fn(),
      findEmployeeById: vi.fn(),
      findEmployeeByWorkEmail: vi.fn(),
      findPotentialDuplicateEmployee: vi.fn(),
      listActiveAccessForEmployee: vi.fn(),
      searchAccessGrants: vi.fn(),
      getAccessDetailReport: vi.fn()
    };
    emailReadService = {
      listEmployeeEmails: vi.fn()
    };

    service = new EmployeesService(
      repository as unknown as EmployeesRepository,
      emailReadService as unknown as EmailReadService
    );
  });

  it("creates an employee with validated input and default actor", async () => {
    const employee = makeEmployee({
      fullName: "Riya Sharma",
      workEmail: null,
      personalEmail: "riya.personal@example.com"
    });

    repository.createEmployee.mockResolvedValue(employee);

    await expect(
      service.createEmployee({
        fullName: " Riya Sharma ",
        personalEmail: "riya.personal@example.com",
        workEmail: null,
        employmentType: "fte",
        designation: "Backend Engineer",
        department: "Engineering",
        startDate: "2026-06-10"
      })
    ).resolves.toBe(employee);

    expect(repository.findEmployeeByWorkEmail).not.toHaveBeenCalled();
    expect(repository.findPotentialDuplicateEmployee).toHaveBeenCalledWith({
      fullName: "Riya Sharma",
      personalEmail: "riya.personal@example.com",
      startDate: "2026-06-10"
    });
    expect(repository.createEmployee).toHaveBeenCalledWith(
      {
        fullName: "Riya Sharma",
        personalEmail: "riya.personal@example.com",
        workEmail: null,
        employmentType: "fte",
        designation: "Backend Engineer",
        department: "Engineering",
        startDate: "2026-06-10"
      },
      "system"
    );
  });

  it("uses createdByExternalUserId as the audit actor", async () => {
    const employee = makeEmployee();

    repository.findEmployeeByWorkEmail.mockResolvedValue(undefined);
    repository.createEmployee.mockResolvedValue(employee);

    await service.createEmployee({
      fullName: "Riya Sharma",
      personalEmail: "riya.personal@example.com",
      workEmail: "riya.sharma@example.com",
      employmentType: "fte",
      designation: "Backend Engineer",
      department: "Engineering",
      startDate: "2026-06-10",
      createdByExternalUserId: "slack-user-123"
    });

    expect(repository.createEmployee).toHaveBeenCalledWith(
      expect.objectContaining({ workEmail: "riya.sharma@example.com" }),
      "slack-user-123"
    );
  });

  it("rejects invalid create payloads", async () => {
    await expectInvalidPayload(
      service.createEmployee({
        fullName: "",
        employmentType: "intern",
        designation: ""
      })
    );

    expect(repository.createEmployee).not.toHaveBeenCalled();
  });

  it("rejects duplicate workEmail before creating", async () => {
    repository.findEmployeeByWorkEmail.mockResolvedValue(makeEmployee());

    await expect(
      service.createEmployee({
        fullName: "Riya Sharma",
        personalEmail: "riya.personal@example.com",
        workEmail: "riya.sharma@example.com",
        employmentType: "fte",
        designation: "Backend Engineer",
        department: "Engineering",
        startDate: "2026-06-10"
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.createEmployee).not.toHaveBeenCalled();
  });

  it("rejects potential duplicate employees before creating", async () => {
    repository.findPotentialDuplicateEmployee.mockResolvedValue(makeEmployee());

    await expect(
      service.createEmployee({
        fullName: "Riya Sharma",
        personalEmail: "riya.personal@example.com",
        workEmail: null,
        employmentType: "fte",
        designation: "Backend Engineer",
        department: "Engineering",
        startDate: "2026-06-10"
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.createEmployee).not.toHaveBeenCalled();
  });

  it("maps database unique violations to conflict errors", async () => {
    repository.findEmployeeByWorkEmail.mockResolvedValue(undefined);
    repository.findPotentialDuplicateEmployee.mockResolvedValue(undefined);
    repository.createEmployee.mockRejectedValue({ code: "23505" });

    await expect(
      service.createEmployee({
        fullName: "Riya Sharma",
        personalEmail: "riya.personal@example.com",
        workEmail: "riya.sharma@example.com",
        employmentType: "fte",
        designation: "Backend Engineer",
        department: "Engineering",
        startDate: "2026-06-10"
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("lists employees through the repository", async () => {
    const employees = [makeEmployee()];
    const result = makeEmployeeListResult(employees);
    repository.listEmployees.mockResolvedValue(result);

    await expect(service.listEmployees()).resolves.toBe(result);
    expect(repository.listEmployees).toHaveBeenCalledWith({
      query: undefined,
      status: "open",
      page: 1,
      pageSize: 20
    });
    expect(repository.searchEmployees).not.toHaveBeenCalled();
  });

  it("treats empty employee search query as a list request", async () => {
    const employees = [makeEmployee()];
    const result = makeEmployeeListResult(employees);
    repository.listEmployees.mockResolvedValue(result);

    await expect(service.listEmployees({ query: "   " })).resolves.toBe(result);

    expect(repository.listEmployees).toHaveBeenCalledWith({
      query: undefined,
      status: "open",
      page: 1,
      pageSize: 20
    });
    expect(repository.searchEmployees).not.toHaveBeenCalled();
  });

  it("lists employees with a trimmed query and explicit filters", async () => {
    const employees = [makeEmployee()];
    const result = makeEmployeeListResult(employees, {
      page: 2,
      pageSize: 10,
      total: 11,
      hasNextPage: true
    });
    repository.listEmployees.mockResolvedValue(result);

    await expect(service.listEmployees({
      query: " riya ",
      status: "active",
      page: "2",
      pageSize: "10"
    })).resolves.toBe(result);

    expect(repository.listEmployees).toHaveBeenCalledWith({
      query: "riya",
      status: "active",
      page: 2,
      pageSize: 10
    });
    expect(repository.searchEmployees).not.toHaveBeenCalled();
  });

  it("searches access grants with validated filters", async () => {
    const result = {
      grants: [
        {
          grantId: "7c644f93-056a-40bf-815a-9512e050aab5",
          employee: {
            id: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
            fullName: "Akhay Khan",
            workEmail: "akhay.khan@caw.tech",
            status: EMPLOYEE_STATUS.offboarded
          },
          system: {
            key: "slack",
            name: "Slack"
          },
          resource: {
            key: "workspace_membership",
            name: "Workspace Membership",
            resourceType: "workspace"
          },
          role: {
            key: "member",
            name: "Member",
            riskLevel: ROLE_RISK_LEVEL.medium
          },
          status: ACCESS_GRANT_STATUS.revoked,
          externalAccountId: null,
          grantedAt: null,
          revokedAt: new Date("2026-06-25T00:00:00.000Z"),
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
          updatedAt: new Date("2026-06-25T00:00:00.000Z")
        }
      ]
    };

    repository.searchAccessGrants.mockResolvedValue(result);

    await expect(service.searchAccessGrants({
      employeeQuery: " akhay.khan@caw.tech ",
      systemKey: "slack",
      mode: "inactive"
    })).resolves.toBe(result);

    expect(repository.searchAccessGrants).toHaveBeenCalledWith({
      employeeQuery: "akhay.khan@caw.tech",
      systemKey: "slack",
      mode: "inactive"
    });
  });

  it("rejects invalid access grant search filters", async () => {
    await expect(service.searchAccessGrants({
      status: "inactive"
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.searchAccessGrants).not.toHaveBeenCalled();
  });

  it("gets an access detail report with validated filters", async () => {
    const result = {
      reportType: "offboarding_audit",
      employees: [],
      accessRequests: [],
      approvals: [],
      accessTasks: [],
      accessGrants: [],
      offboardingIntakes: [],
      offboardingApprovals: [],
      auditEvents: []
    };

    repository.getAccessDetailReport.mockResolvedValue(result);

    await expect(service.getAccessDetailReport({
      employeeQuery: " akhay.khan@caw.tech ",
      reportType: "offboarding_audit"
    })).resolves.toBe(result);

    expect(repository.getAccessDetailReport).toHaveBeenCalledWith({
      employeeQuery: "akhay.khan@caw.tech",
      reportType: "offboarding_audit"
    });
  });

  it("rejects invalid access detail report filters", async () => {
    await expect(service.getAccessDetailReport({
      employeeQuery: "",
      reportType: "debug_everything"
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.getAccessDetailReport).not.toHaveBeenCalled();
  });

  it("resolves an exact company email without requiring confirmation", async () => {
    const employee = makeEmployee({ workEmail: "riya.sharma@example.com" });
    repository.findEmployeeByWorkEmail.mockResolvedValue(employee);

    await expect(service.resolveEmployee({
      query: " Riya.Sharma@example.com ",
      purpose: "offboarding"
    })).resolves.toEqual({
      status: "resolved",
      query: "Riya.Sharma@example.com",
      purpose: "offboarding",
      employee: {
        employeeId: employee.id,
        fullName: employee.fullName,
        workEmail: employee.workEmail,
        status: employee.status,
        designation: employee.designation,
        department: employee.department
      },
      matches: [
        {
          employeeId: employee.id,
          fullName: employee.fullName,
          workEmail: employee.workEmail,
          status: employee.status,
          designation: employee.designation,
          department: employee.department
        }
      ]
    });

    expect(repository.findEmployeeByWorkEmail).toHaveBeenCalledWith("riya.sharma@example.com");
    expect(repository.searchEmployees).not.toHaveBeenCalled();
  });

  it("requires confirmation for a single name match before mutating workflows", async () => {
    const employee = makeEmployee();
    repository.searchEmployees.mockResolvedValue([employee]);

    await expect(service.resolveEmployee({
      query: " riya ",
      purpose: "mutate"
    })).resolves.toMatchObject({
      status: "needs_confirmation",
      query: "riya",
      purpose: "mutate",
      employee: {
        employeeId: employee.id,
        fullName: employee.fullName,
        workEmail: employee.workEmail
      },
      matches: [
        {
          employeeId: employee.id,
          fullName: employee.fullName,
          workEmail: employee.workEmail
        }
      ]
    });

    expect(repository.searchEmployees).toHaveBeenCalledWith("riya");
  });

  it("returns multiple matches for ambiguous employee resolution", async () => {
    repository.searchEmployees.mockResolvedValue([
      makeEmployee({ id: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe", fullName: "Akshay Khan" }),
      makeEmployee({ id: "8cb51d78-a325-46e1-94f1-8b2bc7bc4fff", fullName: "Akhay Khan" })
    ]);

    await expect(service.resolveEmployee({
      query: "akhay",
      purpose: "offboarding"
    })).resolves.toMatchObject({
      status: "multiple_matches",
      query: "akhay",
      purpose: "offboarding",
      employee: null,
      matches: [
        { fullName: "Akshay Khan" },
        { fullName: "Akhay Khan" }
      ]
    });
  });

  it("returns not found for unresolved employee identity", async () => {
    repository.searchEmployees.mockResolvedValue([]);

    await expect(service.resolveEmployee({
      query: "missing employee"
    })).resolves.toEqual({
      status: "not_found",
      query: "missing employee",
      purpose: "read",
      employee: null,
      matches: []
    });
  });

  it("rejects employee search queries longer than 200 characters", async () => {
    await expect(service.listEmployees({ query: "a".repeat(201) })).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.listEmployees).not.toHaveBeenCalled();
    expect(repository.searchEmployees).not.toHaveBeenCalled();
  });

  it("rejects invalid employee list filters", async () => {
    await expect(service.listEmployees({ status: "former" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listEmployees({ page: "0" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listEmployees({ pageSize: "51" })).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.listEmployees).not.toHaveBeenCalled();
  });

  it("returns an employee by id", async () => {
    const employee = makeEmployee();
    repository.findEmployeeById.mockResolvedValue(employee);

    await expect(service.findEmployeeById(employee.id)).resolves.toBe(employee);
  });

  it("returns not found for malformed and missing ids", async () => {
    await expect(service.findEmployeeById("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findEmployeeById).not.toHaveBeenCalled();

    repository.findEmployeeById.mockResolvedValue(undefined);

    await expect(service.findEmployeeById("8cb51d78-a325-46e1-94f1-8b2bc7bc4000")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("returns active access for an employee", async () => {
    const employee = makeEmployee();
    const accessSummary = makeEmployeeAccessSummary({ employee });
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listActiveAccessForEmployee.mockResolvedValue(accessSummary);

    await expect(service.listEmployeeAccess(employee.id)).resolves.toBe(accessSummary);

    expect(repository.listActiveAccessForEmployee).toHaveBeenCalledWith(employee);
  });

  it("returns active Slack channel access for an employee", async () => {
    const employee = makeEmployee();
    const accessSummary = makeEmployeeAccessSummary({
      employee,
      access: [
        {
          grantId: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
          system: {
            key: "slack",
            name: "Slack"
          },
          resource: {
            key: "backend-alerts",
            name: "#backend-alerts",
            resourceType: "channel"
          },
          role: {
            key: "member",
            name: "Member",
            riskLevel: ROLE_RISK_LEVEL.low
          },
          status: ACCESS_GRANT_STATUS.active,
          externalAccountId: "manual:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:backend-alerts",
          grantedAt: new Date("2026-06-01T00:00:00.000Z")
        }
      ]
    });
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listActiveAccessForEmployee.mockResolvedValue(accessSummary);

    await expect(service.listEmployeeAccess(employee.id)).resolves.toEqual(accessSummary);
  });

  it("returns an empty access array for an employee with no active access", async () => {
    const employee = makeEmployee();
    const accessSummary = makeEmployeeAccessSummary({ employee, access: [] });
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listActiveAccessForEmployee.mockResolvedValue(accessSummary);

    await expect(service.listEmployeeAccess(employee.id)).resolves.toEqual({
      employee: accessSummary.employee,
      access: []
    });
  });

  it("returns not found when listing access for malformed and missing employee ids", async () => {
    await expect(service.listEmployeeAccess("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findEmployeeById).not.toHaveBeenCalled();

    repository.findEmployeeById.mockResolvedValue(undefined);

    await expect(service.listEmployeeAccess("8cb51d78-a325-46e1-94f1-8b2bc7bc4000")).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(repository.listActiveAccessForEmployee).not.toHaveBeenCalled();
  });

  it("returns email messages for an employee", async () => {
    const employee = makeEmployee();
    const emailMessages = [makeSafeEmailMessage()];
    repository.findEmployeeById.mockResolvedValue(employee);
    emailReadService.listEmployeeEmails.mockResolvedValue(emailMessages);

    await expect(service.listEmployeeEmails(employee.id)).resolves.toBe(emailMessages);

    expect(emailReadService.listEmployeeEmails).toHaveBeenCalledWith(employee.id);
  });

  it("returns not found when listing emails for malformed and missing employee ids", async () => {
    await expect(service.listEmployeeEmails("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findEmployeeById).not.toHaveBeenCalled();

    repository.findEmployeeById.mockResolvedValue(undefined);

    await expect(service.listEmployeeEmails("8cb51d78-a325-46e1-94f1-8b2bc7bc4000")).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(emailReadService.listEmployeeEmails).not.toHaveBeenCalled();
  });
});

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

function makeEmployeeListResult(
  employees: Employee[],
  overrides: Partial<{
    page: number;
    pageSize: number;
    total: number;
    hasNextPage: boolean;
  }> = {}
) {
  return {
    employees,
    page: 1,
    pageSize: 20,
    total: employees.length,
    hasNextPage: false,
    ...overrides
  };
}

function makeEmployeeAccessSummary(
  overrides: Partial<EmployeeAccessSummary> & { employee?: Employee } = {}
): EmployeeAccessSummary {
  const employee = overrides.employee ?? makeEmployee();

  return {
    employee: {
      id: employee.id,
      fullName: employee.fullName,
      workEmail: employee.workEmail,
      status: employee.status
    },
    access: [
      {
        grantId: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
        system: {
          key: "google_workspace",
          name: "Google Workspace"
        },
        resource: {
          key: "company_email",
          name: "Company Email Account",
          resourceType: "account"
        },
        role: {
          key: "user",
          name: "User",
          riskLevel: ROLE_RISK_LEVEL.medium
        },
        status: ACCESS_GRANT_STATUS.active,
        externalAccountId: "riya.sharma@company.com",
        grantedAt: new Date("2026-06-01T00:00:00.000Z")
      }
    ],
    ...overrides
  };
}

function makeSafeEmailMessage(overrides: Partial<SafeEmailMessage> = {}): SafeEmailMessage {
  return {
    id: "6918c459-68a4-4604-9135-624f4f858ecb",
    templateKey: "google_workspace_welcome",
    senderType: "itops",
    fromEmail: "itops@caw.tech",
    toEmail: "riya.personal@example.com",
    subject: "Your CAW email account is ready",
    status: "sent",
    provider: "gmail",
    providerMessageId: "gmail-message-1",
    relatedEntityType: "access_task",
    relatedEntityId: "5be86c97-ed19-4eb6-b114-fc4305aab8d7",
    errorMessage: null,
    metadataJson: {
      employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
      accessTaskId: "5be86c97-ed19-4eb6-b114-fc4305aab8d7",
      workEmail: "riya.sharma@company.com"
    },
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    sentAt: new Date("2026-06-01T00:01:00.000Z"),
    updatedAt: new Date("2026-06-01T00:01:00.000Z"),
    ...overrides
  };
}

async function expectInvalidPayload(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      statusCode: 400,
      error: "Bad Request",
      message: "Invalid employee payload.",
      details: [
        {
          field: "fullName",
          message: "String must contain at least 1 character(s)"
        },
        {
          field: "employmentType",
          message: "Invalid enum value. Expected 'fte' | 'contractor', received 'intern'"
        },
        {
          field: "designation",
          message: "String must contain at least 1 character(s)"
        }
      ]
    });
    return;
  }

  throw new Error("Expected createEmployee to reject with BadRequestException.");
}

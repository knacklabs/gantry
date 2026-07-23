import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import { formatZodIssues, isUuid } from "../../common/validation.js";
import { accessDetailReportSchema } from "./dto/access-detail-report.dto.js";
import { EmailReadService, type SafeEmailMessage } from "../email/email-read.service.js";
import { createEmployeeSchema } from "./dto/create-employee.dto.js";
import {
  EMPLOYEE_RESOLUTION_PURPOSE,
  EMPLOYEE_RESOLUTION_STATUS,
  resolveEmployeeSchema,
  type ResolveEmployeeResult,
  type ResolvedEmployeeSummary
} from "./dto/resolve-employee.dto.js";
import { searchAccessGrantsSchema } from "./dto/search-access-grants.dto.js";
import {
  EmployeesRepository,
  type AccessDetailReport,
  type AccessGrantSearchResult,
  type Employee,
  type EmployeeAccessSummary,
  type EmployeeListStatus,
  type ListEmployeesRepositoryResult
} from "./employees.repository.js";

export type ListEmployeesInput = {
  query?: string;
  status?: string;
  page?: string | number;
  pageSize?: string | number;
};

@Injectable()
export class EmployeesService {
  constructor(
    private readonly employeesRepository: EmployeesRepository,
    private readonly emailReadService: EmailReadService
  ) {}

  async createEmployee(input: unknown): Promise<Employee> {
    const parsed = createEmployeeSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid employee payload.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    const createEmployeeDto = parsed.data;

    if (createEmployeeDto.workEmail) {
      const existingEmployee = await this.employeesRepository.findEmployeeByWorkEmail(createEmployeeDto.workEmail);

      if (existingEmployee) {
        throw new ConflictException("workEmail must be unique.");
      }
    }

    if (createEmployeeDto.personalEmail && createEmployeeDto.startDate) {
      const duplicateEmployee = await this.employeesRepository.findPotentialDuplicateEmployee({
        fullName: createEmployeeDto.fullName,
        personalEmail: createEmployeeDto.personalEmail,
        startDate: createEmployeeDto.startDate
      });

      if (duplicateEmployee) {
        throw new ConflictException(
          "Potential duplicate employee exists for fullName, personalEmail, and startDate."
        );
      }
    }

    try {
      const { createdByExternalUserId, ...employeeInput } = createEmployeeDto;
      return await this.employeesRepository.createEmployee(employeeInput, createdByExternalUserId ?? "system");
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("workEmail must be unique.");
      }

      throw error;
    }
  }

  async listEmployees(input: ListEmployeesInput = {}): Promise<ListEmployeesRepositoryResult> {
    const trimmedQuery = input.query?.trim();

    if (trimmedQuery && trimmedQuery.length > 200) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Employee search query must be 200 characters or fewer."
      });
    }

    return this.employeesRepository.listEmployees({
      query: trimmedQuery || undefined,
      status: parseEmployeeListStatus(input.status),
      page: parsePositiveInteger(input.page, "page", 1, 10_000),
      pageSize: parsePositiveInteger(input.pageSize, "pageSize", 20, 50)
    });
  }

  async resolveEmployee(input: unknown): Promise<ResolveEmployeeResult> {
    const parsed = resolveEmployeeSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid employee resolution payload.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    const query = parsed.data.query;
    const purpose = parsed.data.purpose ?? EMPLOYEE_RESOLUTION_PURPOSE.read;

    if (isEmailLike(query)) {
      const employee = await this.employeesRepository.findEmployeeByWorkEmail(query.toLowerCase());

      if (!employee) {
        return {
          status: EMPLOYEE_RESOLUTION_STATUS.notFound,
          query,
          purpose,
          employee: null,
          matches: []
        };
      }

      const summary = toResolvedEmployeeSummary(employee);

      return {
        status: EMPLOYEE_RESOLUTION_STATUS.resolved,
        query,
        purpose,
        employee: summary,
        matches: [summary]
      };
    }

    const matches = (await this.employeesRepository.searchEmployees(query))
      .map(toResolvedEmployeeSummary);

    if (matches.length === 0) {
      return {
        status: EMPLOYEE_RESOLUTION_STATUS.notFound,
        query,
        purpose,
        employee: null,
        matches: []
      };
    }

    if (matches.length > 1) {
      return {
        status: EMPLOYEE_RESOLUTION_STATUS.multipleMatches,
        query,
        purpose,
        employee: null,
        matches
      };
    }

    const [employee] = matches;
    const requiresConfirmation =
      purpose === EMPLOYEE_RESOLUTION_PURPOSE.mutate ||
      purpose === EMPLOYEE_RESOLUTION_PURPOSE.offboarding;

    return {
      status: requiresConfirmation
        ? EMPLOYEE_RESOLUTION_STATUS.needsConfirmation
        : EMPLOYEE_RESOLUTION_STATUS.resolved,
      query,
      purpose,
      employee,
      matches
    };
  }

  async findEmployeeById(id: string): Promise<Employee> {
    if (!isUuid(id)) {
      throw new NotFoundException("Employee not found.");
    }

    const employee = await this.employeesRepository.findEmployeeById(id);

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    return employee;
  }

  async listEmployeeAccess(id: string): Promise<EmployeeAccessSummary> {
    if (!isUuid(id)) {
      throw new NotFoundException("Employee not found.");
    }

    const employee = await this.employeesRepository.findEmployeeById(id);

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    return this.employeesRepository.listActiveAccessForEmployee(employee);
  }

  async searchAccessGrants(input: unknown): Promise<AccessGrantSearchResult> {
    const parsed = searchAccessGrantsSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid access grant search filters.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    return this.employeesRepository.searchAccessGrants(parsed.data);
  }

  async getAccessDetailReport(input: unknown): Promise<AccessDetailReport> {
    const parsed = accessDetailReportSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid access detail report filters.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    return this.employeesRepository.getAccessDetailReport(parsed.data);
  }

  async listEmployeeEmails(id: string): Promise<SafeEmailMessage[]> {
    if (!isUuid(id)) {
      throw new NotFoundException("Employee not found.");
    }

    const employee = await this.employeesRepository.findEmployeeById(id);

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    return this.emailReadService.listEmployeeEmails(employee.id);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

const EMPLOYEE_LIST_STATUSES: readonly EmployeeListStatus[] = [
  "open",
  "active",
  "preboarding",
  "offboarding",
  "offboarded",
  "all"
];

function parseEmployeeListStatus(value: string | undefined): EmployeeListStatus {
  const status = value?.trim() || "open";

  if (EMPLOYEE_LIST_STATUSES.includes(status as EmployeeListStatus)) {
    return status as EmployeeListStatus;
  }

  throw new BadRequestException({
    statusCode: 400,
    error: "Bad Request",
    message: "Employee status filter must be one of: open, active, preboarding, offboarding, offboarded, all."
  });
}

function parsePositiveInteger(
  value: string | number | undefined,
  fieldName: "page" | "pageSize",
  fallback: number,
  max: number
): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      message: `${fieldName} must be an integer between 1 and ${max}.`
    });
  }

  return parsed;
}

function toResolvedEmployeeSummary(employee: Employee): ResolvedEmployeeSummary {
  return {
    employeeId: employee.id,
    fullName: employee.fullName,
    workEmail: employee.workEmail,
    status: employee.status,
    designation: employee.designation,
    department: employee.department
  };
}

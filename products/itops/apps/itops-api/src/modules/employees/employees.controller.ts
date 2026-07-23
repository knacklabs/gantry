import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags
} from "@nestjs/swagger";

import { CreateEmployeeDto } from "./dto/create-employee.dto.js";
import { AccessDetailReportQueryDto } from "./dto/access-detail-report.dto.js";
import { EmployeeAccessSummaryDto, EmployeeDto, ListEmployeesResponseDto } from "./dto/employee.dto.js";
import { ResolveEmployeeDto, ResolveEmployeeResultDto, type ResolveEmployeeResult } from "./dto/resolve-employee.dto.js";
import { SearchAccessGrantsQueryDto } from "./dto/search-access-grants.dto.js";
import { EmployeesService } from "./employees.service.js";
import type { AccessDetailReport, AccessGrantSearchResult, Employee, EmployeeAccessSummary } from "./employees.repository.js";
import { EmailMessageDto } from "../email/dto/email-message.dto.js";
import type { SafeEmailMessage } from "../email/email-read.service.js";

@ApiTags("Employees")
@Controller("employees")
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Post()
  @ApiOperation({ summary: "Create an employee" })
  @ApiCreatedResponse({ description: "Employee created.", type: EmployeeDto })
  @ApiBadRequestResponse({ description: "Invalid employee payload." })
  @ApiConflictResponse({ description: "workEmail must be unique." })
  createEmployee(@Body() body: CreateEmployeeDto): Promise<Employee> {
    return this.employeesService.createEmployee(body);
  }

  @Get()
  @ApiOperation({ summary: "List employees with pagination" })
  @ApiOkResponse({ description: "Employees returned.", type: ListEmployeesResponseDto })
  listEmployees(
    @Query("query") query?: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ): ReturnType<EmployeesService["listEmployees"]> {
    return this.employeesService.listEmployees({ query, status, page, pageSize });
  }

  @Post("resolve")
  @ApiOperation({ summary: "Resolve an employee safely from a name or company email" })
  @ApiOkResponse({ description: "Employee resolution returned.", type: ResolveEmployeeResultDto })
  @ApiBadRequestResponse({ description: "Invalid employee resolution payload." })
  resolveEmployee(@Body() body: ResolveEmployeeDto): Promise<ResolveEmployeeResult> {
    return this.employeesService.resolveEmployee(body);
  }

  @Get("access-grants/search")
  @ApiOperation({ summary: "Search access grants by employee, system, resource, status, or mode" })
  @ApiOkResponse({ description: "Access grants returned." })
  @ApiBadRequestResponse({ description: "Invalid access grant search filters." })
  searchAccessGrants(@Query() query: SearchAccessGrantsQueryDto): Promise<AccessGrantSearchResult> {
    return this.employeesService.searchAccessGrants(query);
  }

  @Get("access-detail-report")
  @ApiOperation({ summary: "Get sanitized access workflow detail for one employee" })
  @ApiOkResponse({ description: "Access detail report returned." })
  @ApiBadRequestResponse({ description: "Invalid access detail report filters." })
  getAccessDetailReport(@Query() query: AccessDetailReportQueryDto): Promise<AccessDetailReport> {
    return this.employeesService.getAccessDetailReport(query);
  }

  @Get(":id/access")
  @ApiOperation({ summary: "List active access for an employee" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Employee active access returned.", type: EmployeeAccessSummaryDto })
  @ApiNotFoundResponse({ description: "Employee not found." })
  listEmployeeAccess(@Param("id") id: string): Promise<EmployeeAccessSummary> {
    return this.employeesService.listEmployeeAccess(id);
  }

  @Get(":id/emails")
  @ApiOperation({ summary: "List email messages for an employee" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Employee email messages returned.", type: EmailMessageDto, isArray: true })
  @ApiNotFoundResponse({ description: "Employee not found." })
  listEmployeeEmails(@Param("id") id: string): Promise<SafeEmailMessage[]> {
    return this.employeesService.listEmployeeEmails(id);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get employee by id" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Employee returned.", type: EmployeeDto })
  @ApiNotFoundResponse({ description: "Employee not found." })
  findEmployeeById(@Param("id") id: string): Promise<Employee> {
    return this.employeesService.findEmployeeById(id);
  }
}

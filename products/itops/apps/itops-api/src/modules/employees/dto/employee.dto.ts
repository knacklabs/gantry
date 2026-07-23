import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ACCESS_GRANT_STATUS,
  ACCESS_GRANT_STATUS_VALUES,
  EMPLOYEE_STATUS,
  EMPLOYEE_STATUS_VALUES,
  ROLE_RISK_LEVEL,
  ROLE_RISK_LEVEL_VALUES
} from "@itops/db";

export class EmployeeDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "Riya Sharma" })
  fullName!: string;

  @ApiPropertyOptional({ type: String, format: "email", nullable: true, example: "riya.sharma@example.com" })
  workEmail!: string | null;

  @ApiPropertyOptional({ type: String, format: "email", nullable: true, example: "riya.personal@example.com" })
  personalEmail!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  contactNo!: string | null;

  @ApiProperty({ enum: ["fte", "contractor"], example: "fte" })
  employmentType!: "fte" | "contractor";

  @ApiProperty({ type: String, example: "Backend Engineer" })
  designation!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "Engineering" })
  department!: string | null;

  @ApiProperty({ enum: EMPLOYEE_STATUS_VALUES, example: EMPLOYEE_STATUS.preboarding })
  status!: (typeof EMPLOYEE_STATUS_VALUES)[number];

  @ApiPropertyOptional({ type: String, format: "date", nullable: true, example: "2026-06-10" })
  startDate!: string | null;

  @ApiPropertyOptional({ type: String, format: "date", nullable: true })
  endDate!: string | null;

  @ApiProperty({ type: Date, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: Date, format: "date-time" })
  updatedAt!: Date;
}

export class ListEmployeesResponseDto {
  @ApiProperty({ type: EmployeeDto, isArray: true })
  employees!: EmployeeDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 42 })
  total!: number;

  @ApiProperty({ type: Boolean, example: true })
  hasNextPage!: boolean;
}

export class EmployeeAccessEmployeeDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "Riya Sharma" })
  fullName!: string;

  @ApiPropertyOptional({ type: String, format: "email", nullable: true, example: "riya.sharma@company.com" })
  workEmail!: string | null;

  @ApiProperty({ enum: EMPLOYEE_STATUS_VALUES, example: EMPLOYEE_STATUS.preboarding })
  status!: (typeof EMPLOYEE_STATUS_VALUES)[number];
}

export class EmployeeAccessSystemDto {
  @ApiProperty({ type: String, example: "google_workspace" })
  key!: string;

  @ApiProperty({ type: String, example: "Google Workspace" })
  name!: string;
}

export class EmployeeAccessResourceDto {
  @ApiProperty({ type: String, example: "company_email" })
  key!: string;

  @ApiProperty({ type: String, example: "Company Email Account" })
  name!: string;

  @ApiProperty({ type: String, example: "account" })
  resourceType!: string;
}

export class EmployeeAccessRoleDto {
  @ApiProperty({ type: String, example: "user" })
  key!: string;

  @ApiProperty({ type: String, example: "User" })
  name!: string;

  @ApiProperty({ enum: ROLE_RISK_LEVEL_VALUES, example: ROLE_RISK_LEVEL.medium })
  riskLevel!: (typeof ROLE_RISK_LEVEL_VALUES)[number];
}

export class EmployeeAccessGrantDto {
  @ApiProperty({ type: String, format: "uuid" })
  grantId!: string;

  @ApiProperty({ type: EmployeeAccessSystemDto })
  system!: EmployeeAccessSystemDto;

  @ApiProperty({ type: EmployeeAccessResourceDto })
  resource!: EmployeeAccessResourceDto;

  @ApiProperty({ type: EmployeeAccessRoleDto })
  role!: EmployeeAccessRoleDto;

  @ApiProperty({ enum: ACCESS_GRANT_STATUS_VALUES, example: ACCESS_GRANT_STATUS.active })
  status!: typeof ACCESS_GRANT_STATUS.active;

  @ApiPropertyOptional({ type: String, nullable: true, example: "riya.sharma@company.com" })
  externalAccountId!: string | null;

  @ApiPropertyOptional({ type: Date, format: "date-time", nullable: true })
  grantedAt!: Date | null;
}

export class EmployeeAccessSummaryDto {
  @ApiProperty({ type: EmployeeAccessEmployeeDto })
  employee!: EmployeeAccessEmployeeDto;

  @ApiProperty({ type: EmployeeAccessGrantDto, isArray: true })
  access!: EmployeeAccessGrantDto[];
}

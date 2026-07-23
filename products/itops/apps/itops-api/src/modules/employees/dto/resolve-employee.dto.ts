import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

export const EMPLOYEE_RESOLUTION_PURPOSE = {
  read: "read",
  mutate: "mutate",
  offboarding: "offboarding"
} as const;

export const EMPLOYEE_RESOLUTION_STATUS = {
  resolved: "resolved",
  needsConfirmation: "needs_confirmation",
  multipleMatches: "multiple_matches",
  notFound: "not_found"
} as const;

export const resolveEmployeeSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    purpose: z
      .enum([
        EMPLOYEE_RESOLUTION_PURPOSE.read,
        EMPLOYEE_RESOLUTION_PURPOSE.mutate,
        EMPLOYEE_RESOLUTION_PURPOSE.offboarding
      ])
      .optional()
  })
  .strict();

export type ResolveEmployeeInput = z.infer<typeof resolveEmployeeSchema>;

export type EmployeeResolutionPurpose =
  (typeof EMPLOYEE_RESOLUTION_PURPOSE)[keyof typeof EMPLOYEE_RESOLUTION_PURPOSE];

export type EmployeeResolutionStatus =
  (typeof EMPLOYEE_RESOLUTION_STATUS)[keyof typeof EMPLOYEE_RESOLUTION_STATUS];

export type ResolvedEmployeeSummary = {
  employeeId: string;
  fullName: string;
  workEmail: string | null;
  status: string;
  designation: string;
  department: string | null;
};

export type ResolveEmployeeResult = {
  status: EmployeeResolutionStatus;
  query: string;
  purpose: EmployeeResolutionPurpose;
  employee: ResolvedEmployeeSummary | null;
  matches: ResolvedEmployeeSummary[];
};

export class ResolveEmployeeDto implements ResolveEmployeeInput {
  @ApiProperty({ type: String, example: "akay" })
  query!: string;

  @ApiPropertyOptional({
    enum: Object.values(EMPLOYEE_RESOLUTION_PURPOSE),
    example: EMPLOYEE_RESOLUTION_PURPOSE.offboarding
  })
  purpose?: EmployeeResolutionPurpose;
}

export class ResolvedEmployeeSummaryDto implements ResolvedEmployeeSummary {
  @ApiProperty({ type: String, format: "uuid" })
  employeeId!: string;

  @ApiProperty({ type: String, example: "Akhay Khan" })
  fullName!: string;

  @ApiPropertyOptional({ type: String, format: "email", nullable: true, example: "akhay.khan@caw.tech" })
  workEmail!: string | null;

  @ApiProperty({ type: String, example: "active" })
  status!: string;

  @ApiProperty({ type: String, example: "Backend Engineer" })
  designation!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "Engineering" })
  department!: string | null;
}

export class ResolveEmployeeResultDto implements ResolveEmployeeResult {
  @ApiProperty({
    enum: Object.values(EMPLOYEE_RESOLUTION_STATUS),
    example: EMPLOYEE_RESOLUTION_STATUS.multipleMatches
  })
  status!: EmployeeResolutionStatus;

  @ApiProperty({ type: String, example: "akay" })
  query!: string;

  @ApiProperty({
    enum: Object.values(EMPLOYEE_RESOLUTION_PURPOSE),
    example: EMPLOYEE_RESOLUTION_PURPOSE.offboarding
  })
  purpose!: EmployeeResolutionPurpose;

  @ApiPropertyOptional({ type: ResolvedEmployeeSummaryDto, nullable: true })
  employee!: ResolvedEmployeeSummary | null;

  @ApiProperty({ type: ResolvedEmployeeSummaryDto, isArray: true })
  matches!: ResolvedEmployeeSummary[];
}

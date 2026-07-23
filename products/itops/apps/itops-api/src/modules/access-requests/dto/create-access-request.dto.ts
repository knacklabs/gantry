import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_ACTION_VALUES,
  ACCESS_REQUEST_STATUS,
  ACCESS_REQUEST_STATUS_VALUES,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_OPERATION_VALUES,
  ACCESS_TASK_STATUS,
  ACCESS_TASK_STATUS_VALUES,
  ROLE_RISK_LEVEL,
  ROLE_RISK_LEVEL_VALUES
} from "@itops/db";
import { z } from "zod";

export const createAccessRequestSchema = z
  .object({
    employeeId: z.string().uuid(),
    systemKey: z.string().trim().min(1),
    resourceKey: z.string().trim().min(1),
    roleKey: z.string().trim().min(1),
    action: z.enum(ACCESS_REQUEST_ACTION_VALUES),
    reason: z.string().trim().min(1).nullable().optional(),
    requestedByExternalUserId: z.string().trim().min(1),
    requestedFrom: z.string().trim().min(1).nullable().optional()
  })
  .strict();

export type CreateAccessRequestInput = z.infer<typeof createAccessRequestSchema>;

export class CreateAccessRequestDto implements CreateAccessRequestInput {
  @ApiProperty({ type: String, format: "uuid" })
  employeeId!: string;

  @ApiProperty({ type: String, example: "google_workspace" })
  systemKey!: string;

  @ApiProperty({ type: String, example: "company_email" })
  resourceKey!: string;

  @ApiProperty({ type: String, example: "user" })
  roleKey!: string;

  @ApiProperty({ enum: ACCESS_REQUEST_ACTION_VALUES, example: ACCESS_REQUEST_ACTION.grant })
  action!: (typeof ACCESS_REQUEST_ACTION_VALUES)[number];

  @ApiPropertyOptional({ type: String, nullable: true, example: "Create company email during onboarding" })
  reason?: string | null;

  @ApiProperty({ type: String, example: "slack:U123" })
  requestedByExternalUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "api" })
  requestedFrom?: string | null;
}

export class AccessRequestEmployeeDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "Riya Sharma" })
  fullName!: string;

  @ApiPropertyOptional({ type: String, format: "email", nullable: true })
  workEmail!: string | null;
}

export class AccessRequestSystemDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "google_workspace" })
  key!: string;

  @ApiProperty({ type: String, example: "Google Workspace" })
  name!: string;
}

export class AccessRequestResourceDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "company_email" })
  key!: string;

  @ApiProperty({ type: String, example: "Company Email Account" })
  name!: string;

  @ApiProperty({ type: String, example: "account" })
  resourceType!: string;
}

export class AccessRequestRoleDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "user" })
  key!: string;

  @ApiProperty({ type: String, example: "User" })
  name!: string;

  @ApiProperty({ enum: ROLE_RISK_LEVEL_VALUES, example: ROLE_RISK_LEVEL.medium })
  riskLevel!: (typeof ROLE_RISK_LEVEL_VALUES)[number];
}

export class AccessRequestDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  employeeId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  systemId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  resourceId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  roleId!: string;

  @ApiProperty({ enum: ACCESS_REQUEST_ACTION_VALUES, example: ACCESS_REQUEST_ACTION.grant })
  action!: (typeof ACCESS_REQUEST_ACTION_VALUES)[number];

  @ApiProperty({
    enum: ACCESS_REQUEST_STATUS_VALUES,
    example: ACCESS_REQUEST_STATUS.waitingForApproval
  })
  status!: (typeof ACCESS_REQUEST_STATUS_VALUES)[number];

  @ApiPropertyOptional({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, example: "slack:U123" })
  requestedByExternalUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "api" })
  requestedFrom!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  sourceConversationId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  sourceMessageId!: string | null;

  @ApiProperty({ type: Date, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: Date, format: "date-time" })
  updatedAt!: Date;
}

export class AccessRequestDetailDto extends AccessRequestDto {
  @ApiProperty({ type: AccessRequestEmployeeDto })
  employee!: AccessRequestEmployeeDto;

  @ApiProperty({ type: AccessRequestSystemDto })
  system!: AccessRequestSystemDto;

  @ApiProperty({ type: AccessRequestResourceDto })
  resource!: AccessRequestResourceDto;

  @ApiProperty({ type: AccessRequestRoleDto })
  role!: AccessRequestRoleDto;
}

export class AccessTaskDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  accessRequestId!: string;

  @ApiProperty({ enum: ACCESS_TASK_OPERATION_VALUES, example: ACCESS_TASK_OPERATION.grant })
  operation!: (typeof ACCESS_TASK_OPERATION_VALUES)[number];

  @ApiProperty({ type: String, example: "google_workspace" })
  connector!: string;

  @ApiProperty({ enum: ACCESS_TASK_STATUS_VALUES, example: ACCESS_TASK_STATUS.pendingManual })
  status!: (typeof ACCESS_TASK_STATUS_VALUES)[number];

  @ApiProperty({
    type: String,
    example: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:google_workspace:company_email:user"
  })
  idempotencyKey!: string;

  @ApiProperty({ type: Number, example: 0 })
  attemptCount!: number;

  @ApiPropertyOptional({ type: Object, nullable: true })
  externalResultJson!: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  errorMessage!: string | null;

  @ApiProperty({ type: Date, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: Date, format: "date-time" })
  updatedAt!: Date;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ACCESS_GRANT_STATUS_VALUES,
  ACCESS_TASK_STATUS_VALUES
} from "@itops/db";

import {
  OffboardingEmployeeDto,
  OffboardingIntakeDto,
  OffboardingResourceDto,
  OffboardingRoleDto,
  OffboardingSystemDto
} from "./create-offboarding-intake.dto.js";

const OFFBOARDING_WORKFLOW_STATE_VALUES = [
  "waiting_for_approval",
  "approved",
  "revoke_tasks_created",
  "revoking",
  "revoked",
  "finalized",
  "cancelled",
  "failed"
] as const;

const OFFBOARDING_EMPLOYEE_LIFECYCLE_CASE_VALUES = [
  "preboarding_cancellation",
  "active_offboarding",
  "already_offboarding",
  "already_offboarded"
] as const;

export class OffboardingStatusSummaryDto {
  @ApiProperty({ type: Number, example: 4 })
  total!: number;

  @ApiProperty({ type: Number, example: 2 })
  completed!: number;

  @ApiProperty({ type: Number, example: 2 })
  pending!: number;

  @ApiProperty({ type: Number, example: 0 })
  failed!: number;
}

export class OffboardingStatusRevokeItemDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: OffboardingSystemDto })
  system!: OffboardingSystemDto;

  @ApiProperty({ type: OffboardingResourceDto })
  resource!: OffboardingResourceDto;

  @ApiProperty({ type: OffboardingRoleDto })
  role!: OffboardingRoleDto;

  @ApiProperty({ enum: ACCESS_GRANT_STATUS_VALUES, example: "active" })
  grantStatus!: (typeof ACCESS_GRANT_STATUS_VALUES)[number];

  @ApiPropertyOptional({ enum: ACCESS_TASK_STATUS_VALUES, nullable: true, example: "pending" })
  taskStatus!: (typeof ACCESS_TASK_STATUS_VALUES)[number] | null;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  accessTaskId!: string | null;
}

export class OffboardingStatusResponseDto {
  @ApiProperty({ type: OffboardingIntakeDto })
  offboardingIntake!: OffboardingIntakeDto;

  @ApiProperty({ type: OffboardingEmployeeDto })
  employee!: OffboardingEmployeeDto;

  @ApiProperty({ type: OffboardingStatusSummaryDto })
  summary!: OffboardingStatusSummaryDto;

  @ApiProperty({ type: [OffboardingStatusRevokeItemDto] })
  revokeItems!: OffboardingStatusRevokeItemDto[];

  @ApiProperty({ type: Boolean, example: false })
  canFinalize!: boolean;

  @ApiProperty({ enum: OFFBOARDING_WORKFLOW_STATE_VALUES, example: "revoking" })
  workflowState!: (typeof OFFBOARDING_WORKFLOW_STATE_VALUES)[number];

  @ApiProperty({ enum: OFFBOARDING_EMPLOYEE_LIFECYCLE_CASE_VALUES, example: "active_offboarding" })
  employeeLifecycleCase!: (typeof OFFBOARDING_EMPLOYEE_LIFECYCLE_CASE_VALUES)[number];
}

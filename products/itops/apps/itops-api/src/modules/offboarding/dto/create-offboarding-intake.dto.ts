import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  OFFBOARDING_INTAKE_STATUS,
  OFFBOARDING_INTAKE_STATUS_VALUES,
  OFFBOARDING_REVOKE_ITEM_STATUS_VALUES,
  ROLE_RISK_LEVEL,
  ROLE_RISK_LEVEL_VALUES
} from "@itops/db";
import { z } from "zod";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

export const createOffboardingIntakeSchema = z
  .object({
    employeeId: z.string().uuid(),
    lastWorkingDay: z.string().regex(datePattern).nullable().optional(),
    reason: z.string().trim().min(1).nullable().optional(),
    requestedByExternalUserId: z.string().trim().min(1),
    notes: z.string().trim().min(1).nullable().optional()
  })
  .strict();

export type CreateOffboardingIntakeInput = z.infer<typeof createOffboardingIntakeSchema>;

export class CreateOffboardingIntakeDto implements CreateOffboardingIntakeInput {
  @ApiProperty({ type: String, format: "uuid" })
  employeeId!: string;

  @ApiPropertyOptional({ type: String, format: "date", nullable: true, example: "2026-06-30" })
  lastWorkingDay?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "Resignation" })
  reason?: string | null;

  @ApiProperty({ type: String, example: "slack:U123" })
  requestedByExternalUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "Offboarding requested from Slack" })
  notes?: string | null;
}

export class OffboardingEmployeeDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "Riya Sharma" })
  fullName!: string;

  @ApiPropertyOptional({ type: String, format: "email", nullable: true })
  workEmail!: string | null;

  @ApiProperty({ type: String, example: "active" })
  status!: string;
}

export class OffboardingSystemDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "slack" })
  key!: string;

  @ApiProperty({ type: String, example: "Slack" })
  name!: string;
}

export class OffboardingResourceDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "backend-alerts" })
  key!: string;

  @ApiProperty({ type: String, example: "#backend-alerts" })
  name!: string;

  @ApiProperty({ type: String, example: "channel" })
  resourceType!: string;
}

export class OffboardingRoleDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "member" })
  key!: string;

  @ApiProperty({ type: String, example: "Member" })
  name!: string;

  @ApiProperty({ enum: ROLE_RISK_LEVEL_VALUES, example: ROLE_RISK_LEVEL.low })
  riskLevel!: (typeof ROLE_RISK_LEVEL_VALUES)[number];
}

export class OffboardingActiveAccessPreviewDto {
  @ApiProperty({ type: String, format: "uuid" })
  grantId!: string;

  @ApiProperty({ type: OffboardingSystemDto })
  system!: OffboardingSystemDto;

  @ApiProperty({ type: OffboardingResourceDto })
  resource!: OffboardingResourceDto;

  @ApiProperty({ type: OffboardingRoleDto })
  role!: OffboardingRoleDto;

  @ApiProperty({ type: String, example: "active" })
  status!: "active";
}

export class OffboardingIntakeDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  employeeId!: string;

  @ApiProperty({ type: String, example: "slack:U123" })
  requestedByExternalUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  reason!: string | null;

  @ApiPropertyOptional({ type: String, format: "date", nullable: true })
  lastWorkingDay!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ enum: OFFBOARDING_INTAKE_STATUS_VALUES, example: OFFBOARDING_INTAKE_STATUS.waitingForReview })
  status!: (typeof OFFBOARDING_INTAKE_STATUS_VALUES)[number];

  @ApiProperty({ type: Date, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: Date, format: "date-time" })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: Date, format: "date-time", nullable: true })
  approvedAt!: Date | null;

  @ApiPropertyOptional({ type: Date, format: "date-time", nullable: true })
  rejectedAt!: Date | null;

  @ApiPropertyOptional({ type: Date, format: "date-time", nullable: true })
  completedAt!: Date | null;
}

export class OffboardingRevokeItemDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  accessGrantId!: string;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  accessRequestId!: string | null;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  accessTaskId!: string | null;

  @ApiProperty({ enum: OFFBOARDING_REVOKE_ITEM_STATUS_VALUES, example: "pending" })
  status!: (typeof OFFBOARDING_REVOKE_ITEM_STATUS_VALUES)[number];

  @ApiPropertyOptional({ type: String, nullable: true })
  errorMessage!: string | null;

  @ApiProperty({ type: OffboardingSystemDto })
  system!: OffboardingSystemDto;

  @ApiProperty({ type: OffboardingResourceDto })
  resource!: OffboardingResourceDto;

  @ApiProperty({ type: OffboardingRoleDto })
  role!: OffboardingRoleDto;
}

export class CreateOffboardingIntakeResponseDto {
  @ApiPropertyOptional({ type: OffboardingIntakeDto, nullable: true })
  offboardingIntake!: OffboardingIntakeDto | null;

  @ApiProperty({ type: OffboardingEmployeeDto })
  employee!: OffboardingEmployeeDto;

  @ApiProperty({ type: [OffboardingActiveAccessPreviewDto] })
  activeAccessPreview!: OffboardingActiveAccessPreviewDto[];

  @ApiProperty({ type: Number, example: 3 })
  activeAccessCount!: number;

  @ApiProperty({
    enum: ["preboarding_cancellation", "active_offboarding", "already_offboarding", "already_offboarded"],
    example: "active_offboarding"
  })
  employeeLifecycleCase!:
    | "preboarding_cancellation"
    | "active_offboarding"
    | "already_offboarding"
    | "already_offboarded";

  @ApiProperty({ type: String, example: "This will start offboarding and revoke active access after approval." })
  message!: string;

  @ApiProperty({ enum: ["approval_required", "view_existing_status", "no_change"], example: "approval_required" })
  nextAction!: "approval_required" | "view_existing_status" | "no_change";
}

export class OffboardingIntakeDetailDto {
  @ApiProperty({ type: OffboardingIntakeDto })
  offboardingIntake!: OffboardingIntakeDto;

  @ApiProperty({ type: OffboardingEmployeeDto })
  employee!: OffboardingEmployeeDto;

  @ApiProperty({ enum: OFFBOARDING_INTAKE_STATUS_VALUES, example: OFFBOARDING_INTAKE_STATUS.waitingForReview })
  status!: (typeof OFFBOARDING_INTAKE_STATUS_VALUES)[number];

  @ApiProperty({ type: [OffboardingActiveAccessPreviewDto] })
  activeAccessPreview!: OffboardingActiveAccessPreviewDto[];

  @ApiProperty({ type: Number, example: 3 })
  activeAccessCount!: number;

  @ApiProperty({ type: [OffboardingRevokeItemDto] })
  revokeItems!: OffboardingRevokeItemDto[];
}

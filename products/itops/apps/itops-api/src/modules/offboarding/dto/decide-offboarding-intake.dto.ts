import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  OFFBOARDING_INTAKE_APPROVAL_DECISION_VALUES,
  OFFBOARDING_INTAKE_STATUS_VALUES
} from "@itops/db";
import { z } from "zod";

import {
  OffboardingEmployeeDto,
  OffboardingIntakeDto,
  OffboardingResourceDto,
  OffboardingRoleDto,
  OffboardingSystemDto
} from "./create-offboarding-intake.dto.js";

export const decideOffboardingIntakeSchema = z
  .object({
    decision: z.enum(OFFBOARDING_INTAKE_APPROVAL_DECISION_VALUES),
    approverExternalUserId: z.string().trim().min(1),
    comment: z.string().trim().min(1).nullable().optional(),
    source: z.string().trim().min(1).default("slack"),
    gantryConversationId: z.string().trim().min(1).nullable().optional(),
    gantryRuntimeEventId: z.string().trim().min(1).nullable().optional()
  })
  .strict();

export type DecideOffboardingIntakeInput = z.infer<typeof decideOffboardingIntakeSchema>;

export class DecideOffboardingIntakeDto implements DecideOffboardingIntakeInput {
  @ApiProperty({ enum: OFFBOARDING_INTAKE_APPROVAL_DECISION_VALUES, example: "approved" })
  decision!: (typeof OFFBOARDING_INTAKE_APPROVAL_DECISION_VALUES)[number];

  @ApiProperty({ type: String, example: "slack:U_APPROVER" })
  approverExternalUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "Approved offboarding" })
  comment?: string | null;

  @ApiPropertyOptional({ type: String, example: "slack", default: "slack" })
  source!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "optional" })
  gantryConversationId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "optional" })
  gantryRuntimeEventId?: string | null;
}

export class OffboardingIntakeDecisionDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  offboardingIntakeId!: string;

  @ApiProperty({ type: String, example: "slack:U_APPROVER" })
  approverExternalUserId!: string;

  @ApiProperty({ enum: OFFBOARDING_INTAKE_APPROVAL_DECISION_VALUES, example: "approved" })
  decision!: (typeof OFFBOARDING_INTAKE_APPROVAL_DECISION_VALUES)[number];

  @ApiPropertyOptional({ type: String, nullable: true })
  comment!: string | null;

  @ApiProperty({ type: String, example: "slack" })
  source!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  gantryConversationId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  gantryRuntimeEventId!: string | null;

  @ApiProperty({ type: Date, format: "date-time" })
  createdAt!: Date;
}

export class OffboardingDecisionRevokeItemDto {
  @ApiProperty({ type: String, format: "uuid" })
  grantId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  accessRequestId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  accessTaskId!: string;

  @ApiProperty({ type: OffboardingSystemDto })
  system!: OffboardingSystemDto;

  @ApiProperty({ type: OffboardingResourceDto })
  resource!: OffboardingResourceDto;

  @ApiProperty({ type: OffboardingRoleDto })
  role!: OffboardingRoleDto;

  @ApiProperty({ type: String, example: "pending_manual" })
  taskStatus!: "pending" | "pending_manual";
}

export class DecideOffboardingIntakeResponseDto {
  @ApiProperty({ type: OffboardingIntakeDto })
  offboardingIntake!: OffboardingIntakeDto;

  @ApiProperty({ type: OffboardingIntakeDecisionDto })
  decision!: OffboardingIntakeDecisionDto;

  @ApiPropertyOptional({ type: OffboardingEmployeeDto, nullable: true })
  employee!: OffboardingEmployeeDto | null;

  @ApiProperty({ type: [OffboardingDecisionRevokeItemDto] })
  revokeItems!: OffboardingDecisionRevokeItemDto[];

  @ApiPropertyOptional({ type: String, example: "execute_revoke_tasks" })
  nextAction?: "execute_revoke_tasks";

  @ApiProperty({ enum: OFFBOARDING_INTAKE_STATUS_VALUES, example: "in_progress" })
  status!: (typeof OFFBOARDING_INTAKE_STATUS_VALUES)[number];
}

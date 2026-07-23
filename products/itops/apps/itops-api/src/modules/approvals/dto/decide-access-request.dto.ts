import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { APPROVAL_DECISION_VALUES } from "@itops/db";
import { z } from "zod";

import { AccessRequestDto, AccessTaskDto } from "../../access-requests/dto/create-access-request.dto.js";

export const decideAccessRequestSchema = z
  .object({
    decision: z.enum(APPROVAL_DECISION_VALUES),
    approverExternalUserId: z.string().trim().min(1),
    comment: z.string().trim().min(1).nullable().optional(),
    source: z.string().trim().min(1).default("slack"),
    gantryConversationId: z.string().trim().min(1).nullable().optional(),
    gantryRuntimeEventId: z.string().trim().min(1).nullable().optional()
  })
  .strict();

export type DecideAccessRequestInput = z.infer<typeof decideAccessRequestSchema>;

export class DecideAccessRequestDto implements DecideAccessRequestInput {
  @ApiProperty({ enum: APPROVAL_DECISION_VALUES, example: "approved" })
  decision!: (typeof APPROVAL_DECISION_VALUES)[number];

  @ApiProperty({ type: String, example: "slack:U999" })
  approverExternalUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "Approved for onboarding" })
  comment?: string | null;

  @ApiPropertyOptional({ type: String, example: "slack", default: "slack" })
  source!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "optional" })
  gantryConversationId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "optional" })
  gantryRuntimeEventId?: string | null;
}

export class ApprovalDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  accessRequestId!: string;

  @ApiProperty({ type: String, example: "slack:U999" })
  approverExternalUserId!: string;

  @ApiProperty({ enum: APPROVAL_DECISION_VALUES, example: "approved" })
  decision!: (typeof APPROVAL_DECISION_VALUES)[number];

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

export class AccessRequestDecisionResponseDto {
  @ApiProperty({ type: AccessRequestDto })
  accessRequest!: AccessRequestDto;

  @ApiProperty({ type: ApprovalDto })
  approval!: ApprovalDto;

  @ApiPropertyOptional({ type: AccessTaskDto, nullable: true })
  accessTask!: AccessTaskDto | null;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ONBOARDING_INTAKE_APPROVAL_DECISION_VALUES } from "@itops/db";
import { z } from "zod";

export const decideOnboardingIntakeSchema = z
  .object({
    decision: z.enum(ONBOARDING_INTAKE_APPROVAL_DECISION_VALUES),
    approverExternalUserId: z.string().trim().min(1),
    comment: z.string().trim().min(1).nullable().optional(),
    source: z.string().trim().min(1).default("slack"),
    gantryConversationId: z.string().trim().min(1).nullable().optional(),
    gantryRuntimeEventId: z.string().trim().min(1).nullable().optional()
  })
  .strict();

export type DecideOnboardingIntakeInput = z.infer<typeof decideOnboardingIntakeSchema>;

export class DecideOnboardingIntakeDto implements DecideOnboardingIntakeInput {
  @ApiProperty({ enum: ONBOARDING_INTAKE_APPROVAL_DECISION_VALUES, example: "approved" })
  decision!: (typeof ONBOARDING_INTAKE_APPROVAL_DECISION_VALUES)[number];

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

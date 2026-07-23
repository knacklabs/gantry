import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

export const createSlackOnboardingIntakeSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(100),
    channelId: z.string().trim().min(1).max(100),
    messageTs: z.string().trim().min(1).max(100),
    threadTs: z.string().trim().min(1).max(100).nullable().optional(),
    senderSlackUserId: z.string().trim().min(1).max(120).nullable().optional(),
    senderExternalUserId: z.string().trim().min(1).max(150).nullable().optional(),
    rawText: z.string().refine((value) => value.trim().length > 0, {
      message: "rawText is required."
    })
  })
  .strict()
  .refine((value) => value.senderExternalUserId || value.senderSlackUserId, {
    path: ["senderExternalUserId"],
    message: "senderExternalUserId or senderSlackUserId is required."
  });

export type CreateSlackOnboardingIntakeInput = z.infer<typeof createSlackOnboardingIntakeSchema>;

export class CreateSlackOnboardingIntakeDto implements CreateSlackOnboardingIntakeInput {
  @ApiProperty({ type: String, example: "T123" })
  workspaceId!: string;

  @ApiProperty({ type: String, example: "C123" })
  channelId!: string;

  @ApiProperty({ type: String, example: "1710000000.000000" })
  messageTs!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "1710000000.000000" })
  threadTs?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "U123" })
  senderSlackUserId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "slack:U123" })
  senderExternalUserId?: string | null;

  @ApiProperty({ type: String, example: "New Joiner Alert\n\nName: Riya Sharma\nEmail Id: riya@example.com" })
  rawText!: string;
}

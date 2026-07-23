import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { EMAIL_MESSAGE_STATUS_VALUES } from "@itops/db";

export class EmailMessageDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "google_workspace_welcome" })
  templateKey!: string;

  @ApiProperty({ type: String, example: "itops" })
  senderType!: string;

  @ApiProperty({ type: String, format: "email", example: "itops@caw.tech" })
  fromEmail!: string;

  @ApiProperty({ type: String, format: "email", example: "riya.personal@example.com" })
  toEmail!: string;

  @ApiProperty({ type: String, example: "Your CAW email account is ready" })
  subject!: string;

  @ApiProperty({ enum: EMAIL_MESSAGE_STATUS_VALUES, example: "sent" })
  status!: (typeof EMAIL_MESSAGE_STATUS_VALUES)[number];

  @ApiProperty({ type: String, example: "gmail" })
  provider!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "gmail-message-id" })
  providerMessageId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "access_task" })
  relatedEntityType!: string | null;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  relatedEntityId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "gmail_not_configured" })
  errorMessage!: string | null;

  @ApiPropertyOptional({ type: Object, nullable: true })
  metadataJson!: Record<string, unknown> | null;

  @ApiProperty({ type: Date, format: "date-time" })
  createdAt!: Date;

  @ApiPropertyOptional({ type: Date, format: "date-time", nullable: true })
  sentAt!: Date | null;

  @ApiProperty({ type: Date, format: "date-time" })
  updatedAt!: Date;
}

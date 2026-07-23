import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

export const actorExternalUserIdSchema = z.object({
  actorExternalUserId: z.string().trim().min(1).max(180)
});

export const taskStatusDiagnosticsQuerySchema = actorExternalUserIdSchema.extend({
  employeeQuery: z.string().trim().min(1).max(200)
});

export class DiagnosticsAuthQueryDto {
  @ApiProperty({ type: String, example: "slack:U123" })
  actorExternalUserId!: string;
}

export class TaskStatusDiagnosticsQueryDto extends DiagnosticsAuthQueryDto {
  @ApiProperty({ type: String, example: "akhay.khan@caw.tech" })
  employeeQuery!: string;
}

export class DiagnosticsConfigItemDto {
  @ApiProperty({ type: String, example: "GOOGLE_WORKSPACE_ENABLED" })
  key!: string;

  @ApiProperty({ enum: ["present", "missing", "not_required"], example: "present" })
  status!: "present" | "missing" | "not_required";
}

export class DiagnosticsConfigSectionDto {
  @ApiProperty({ type: String, example: "Google Workspace" })
  name!: string;

  @ApiProperty({ type: Boolean, example: true })
  enabled!: boolean;

  @ApiProperty({ type: [DiagnosticsConfigItemDto] })
  requiredConfig!: DiagnosticsConfigItemDto[];
}

export class ConfigHealthDto {
  @ApiProperty({ type: Boolean, example: true })
  GOOGLE_WORKSPACE_ENABLED!: boolean;

  @ApiProperty({ type: Boolean, example: true })
  SLACK_CONNECTOR_ENABLED!: boolean;

  @ApiProperty({ type: Boolean, example: true })
  EMAIL_ENABLED!: boolean;

  @ApiProperty({ type: Boolean, example: true })
  APPROVAL_POLICY_ENABLED!: boolean;

  @ApiProperty({ type: [DiagnosticsConfigSectionDto] })
  sections!: DiagnosticsConfigSectionDto[];
}

export class ConnectorHealthItemDto {
  @ApiProperty({ type: String, example: "Slack channel connector" })
  name!: string;

  @ApiProperty({ type: Boolean, example: true })
  enabled!: boolean;

  @ApiPropertyOptional({ type: String, example: "real" })
  mode?: string;

  @ApiProperty({ enum: ["ready", "not_configured", "disabled"], example: "ready" })
  status!: "ready" | "not_configured" | "disabled";

  @ApiProperty({ type: [String], example: ["SLACK_BOT_TOKEN"] })
  missingConfig!: string[];
}

export class ConnectorHealthDto {
  @ApiProperty({ type: [ConnectorHealthItemDto] })
  connectors!: ConnectorHealthItemDto[];
}

export class DiagnosticsTaskSummaryDto {
  @ApiProperty({ type: String, format: "uuid" })
  accessTaskId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  accessRequestId!: string;

  @ApiProperty({ type: String, example: "failed" })
  status!: string;

  @ApiProperty({ type: String, example: "revoke" })
  operation!: string;

  @ApiProperty({ type: String, example: "slack" })
  connector!: string;

  @ApiProperty({ type: Number, example: 1 })
  attemptCount!: number;

  @ApiProperty({ type: String, example: "Akhay Khan" })
  employeeName!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "akhay.khan@caw.tech" })
  employeeWorkEmail!: string | null;

  @ApiProperty({ type: String, example: "Slack" })
  system!: string;

  @ApiProperty({ type: String, example: "Workspace Membership" })
  resource!: string;

  @ApiProperty({ type: String, example: "Member" })
  role!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "Slack token is missing a required scope." })
  errorSummary!: string | null;

  @ApiPropertyOptional({ type: Object, nullable: true })
  connectorResultSummary!: Record<string, unknown> | null;

  @ApiProperty({ type: Date })
  updatedAt!: Date;
}

export class FailedAccessTasksDiagnosticsDto {
  @ApiProperty({ type: [DiagnosticsTaskSummaryDto] })
  failedAccessTasks!: DiagnosticsTaskSummaryDto[];
}

export class TaskStatusDiagnosticsDto {
  @ApiProperty({ type: [DiagnosticsTaskSummaryDto] })
  tasks!: DiagnosticsTaskSummaryDto[];
}

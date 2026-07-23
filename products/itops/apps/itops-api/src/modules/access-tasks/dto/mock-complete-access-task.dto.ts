import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ACCESS_GRANT_STATUS,
  ACCESS_GRANT_STATUS_VALUES,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_OPERATION_VALUES,
  ACCESS_TASK_STATUS,
  ACCESS_TASK_STATUS_VALUES
} from "@itops/db";
import { z } from "zod";

export const mockCompleteAccessTaskSchema = z
  .object({
    completedByExternalUserId: z.string().trim().min(1),
    externalAccountId: z.string().trim().min(1).nullable().optional(),
    externalResult: z.record(z.unknown()).optional()
  })
  .strict();

export type MockCompleteAccessTaskInput = z.infer<typeof mockCompleteAccessTaskSchema>;

export class MockCompleteAccessTaskDto implements MockCompleteAccessTaskInput {
  @ApiProperty({ type: String, example: "system" })
  completedByExternalUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "manual:employee-id:backend-alerts" })
  externalAccountId?: string | null;

  @ApiPropertyOptional({
    type: Object,
    example: {
      mock: true,
      message: "Google Workspace user would be created here"
    }
  })
  externalResult?: Record<string, unknown>;
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

  @ApiProperty({ enum: ACCESS_TASK_STATUS_VALUES, example: ACCESS_TASK_STATUS.completed })
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

export class AccessGrantDto {
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

  @ApiProperty({ enum: ACCESS_GRANT_STATUS_VALUES, example: ACCESS_GRANT_STATUS.active })
  status!: (typeof ACCESS_GRANT_STATUS_VALUES)[number];

  @ApiPropertyOptional({ type: String, nullable: true, example: "riya.sharma@company.com" })
  externalAccountId!: string | null;

  @ApiPropertyOptional({ type: Date, format: "date-time", nullable: true })
  grantedAt!: Date | null;

  @ApiPropertyOptional({ type: Date, format: "date-time", nullable: true })
  revokedAt!: Date | null;

  @ApiProperty({ type: Date, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: Date, format: "date-time" })
  updatedAt!: Date;
}

export class MockCompleteAccessTaskResponseDto {
  @ApiProperty({ type: AccessTaskDto })
  task!: AccessTaskDto;

  @ApiProperty({ type: AccessGrantDto })
  grant!: AccessGrantDto;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

export const createEmployeeSchema = z
  .object({
    fullName: z.string().trim().min(1),
    personalEmail: z.string().trim().email().nullable().optional(),
    workEmail: z.string().trim().email().nullable().optional(),
    employmentType: z.enum(["fte", "contractor"]),
    designation: z.string().trim().min(1),
    department: z.string().trim().min(1).nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    createdByExternalUserId: z.string().trim().min(1).optional()
  })
  .strict();

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export class CreateEmployeeDto implements CreateEmployeeInput {
  @ApiProperty({ type: String, example: "Riya Sharma" })
  fullName!: string;

  @ApiPropertyOptional({ type: String, format: "email", nullable: true, example: "riya.personal@example.com" })
  personalEmail?: string | null;

  @ApiPropertyOptional({ type: String, format: "email", nullable: true, example: null })
  workEmail?: string | null;

  @ApiProperty({ enum: ["fte", "contractor"], example: "fte" })
  employmentType!: "fte" | "contractor";

  @ApiProperty({ type: String, example: "Backend Engineer" })
  designation!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "Engineering" })
  department?: string | null;

  @ApiPropertyOptional({ type: String, format: "date", nullable: true, example: "2026-06-10" })
  startDate?: string | null;

  @ApiPropertyOptional({ type: String, example: "slack-user-123" })
  createdByExternalUserId?: string;
}

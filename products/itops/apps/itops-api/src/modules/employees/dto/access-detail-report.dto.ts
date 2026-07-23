import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

export const ACCESS_DETAIL_REPORT_TYPES = [
  "offboarding_audit",
  "access_history",
  "revoke_task_status",
  "access_request_status"
] as const;

export const accessDetailReportSchema = z.object({
  employeeQuery: z.string().trim().min(1).max(200),
  reportType: z.enum(ACCESS_DETAIL_REPORT_TYPES)
});

export type AccessDetailReportDto = z.infer<typeof accessDetailReportSchema>;

export class AccessDetailReportQueryDto {
  @ApiProperty({ type: String, example: "akhay.khan@caw.tech" })
  employeeQuery!: string;

  @ApiProperty({ enum: ACCESS_DETAIL_REPORT_TYPES, example: "offboarding_audit" })
  reportType!: (typeof ACCESS_DETAIL_REPORT_TYPES)[number];
}

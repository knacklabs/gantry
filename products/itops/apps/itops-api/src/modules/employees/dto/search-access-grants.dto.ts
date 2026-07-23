import { ApiPropertyOptional } from "@nestjs/swagger";
import { ACCESS_GRANT_STATUS_VALUES } from "@itops/db";
import { z } from "zod";

export const ACCESS_GRANT_SEARCH_MODES = ["active", "inactive", "history"] as const;

export const searchAccessGrantsSchema = z.object({
  employeeQuery: z.string().trim().min(1).max(200).optional(),
  systemKey: z.string().trim().min(1).max(120).optional(),
  resourceKey: z.string().trim().min(1).max(160).optional(),
  status: z.enum(ACCESS_GRANT_STATUS_VALUES).optional(),
  mode: z.enum(ACCESS_GRANT_SEARCH_MODES).optional()
});

export type SearchAccessGrantsDto = z.infer<typeof searchAccessGrantsSchema>;

export class SearchAccessGrantsQueryDto {
  @ApiPropertyOptional({ type: String, example: "akhay.khan@caw.tech" })
  employeeQuery?: string;

  @ApiPropertyOptional({ type: String, example: "slack" })
  systemKey?: string;

  @ApiPropertyOptional({ type: String, example: "workspace_membership" })
  resourceKey?: string;

  @ApiPropertyOptional({ enum: ACCESS_GRANT_STATUS_VALUES, example: "revoked" })
  status?: (typeof ACCESS_GRANT_STATUS_VALUES)[number];

  @ApiPropertyOptional({ enum: ACCESS_GRANT_SEARCH_MODES, example: "inactive" })
  mode?: (typeof ACCESS_GRANT_SEARCH_MODES)[number];
}

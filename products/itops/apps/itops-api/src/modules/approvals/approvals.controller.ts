import { Body, Controller, Param, Post } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags
} from "@nestjs/swagger";

import { ApprovalsService } from "./approvals.service.js";
import type { AccessRequestDecision } from "./approvals.repository.js";
import { AccessRequestDecisionResponseDto, DecideAccessRequestDto } from "./dto/decide-access-request.dto.js";

@ApiTags("Approvals")
@Controller("access-requests")
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Post(":id/decision")
  @ApiOperation({ summary: "Approve or reject an access request" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiCreatedResponse({ description: "Access request decision recorded.", type: AccessRequestDecisionResponseDto })
  @ApiBadRequestResponse({ description: "Invalid decision payload." })
  @ApiNotFoundResponse({ description: "Access request not found." })
  @ApiConflictResponse({ description: "Access request is not waiting for approval." })
  decideAccessRequest(
    @Param("id") id: string,
    @Body() body: DecideAccessRequestDto
  ): Promise<AccessRequestDecision> {
    return this.approvalsService.decideAccessRequest(id, body);
  }
}

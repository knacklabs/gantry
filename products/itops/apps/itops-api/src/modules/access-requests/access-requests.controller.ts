import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags
} from "@nestjs/swagger";

import { AccessRequestsService } from "./access-requests.service.js";
import type { AccessRequest, AccessRequestDetail, AccessTask } from "./access-requests.repository.js";
import {
  AccessRequestDetailDto,
  AccessRequestDto,
  AccessTaskDto,
  CreateAccessRequestDto
} from "./dto/create-access-request.dto.js";

@ApiTags("Access Requests")
@Controller("access-requests")
export class AccessRequestsController {
  constructor(private readonly accessRequestsService: AccessRequestsService) {}

  @Post()
  @ApiOperation({ summary: "Create an access request" })
  @ApiCreatedResponse({ description: "Access request created.", type: AccessRequestDto })
  @ApiBadRequestResponse({ description: "Invalid access request payload." })
  @ApiNotFoundResponse({ description: "Referenced employee, system, resource, or role was not found." })
  @ApiConflictResponse({ description: "Open duplicate access request already exists." })
  createAccessRequest(@Body() body: CreateAccessRequestDto): Promise<AccessRequest> {
    return this.accessRequestsService.createAccessRequest(body);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get access request by id" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Access request returned.", type: AccessRequestDetailDto })
  @ApiNotFoundResponse({ description: "Access request not found." })
  findAccessRequestById(@Param("id") id: string): Promise<AccessRequestDetail> {
    return this.accessRequestsService.findAccessRequestById(id);
  }

  @Get(":id/tasks")
  @ApiOperation({ summary: "List tasks for an access request" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Access request tasks returned.", type: [AccessTaskDto] })
  @ApiNotFoundResponse({ description: "Access request not found." })
  listAccessTasksByAccessRequestId(@Param("id") id: string): Promise<AccessTask[]> {
    return this.accessRequestsService.listAccessTasksByAccessRequestId(id);
  }
}

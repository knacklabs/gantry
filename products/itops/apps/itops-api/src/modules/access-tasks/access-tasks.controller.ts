import { Body, Controller, Param, Post } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags
} from "@nestjs/swagger";

import { AccessTasksService } from "./access-tasks.service.js";
import type { ExecuteAccessTaskResult, MockCompleteAccessTaskResult } from "./access-tasks.repository.js";
import { MockCompleteAccessTaskDto, MockCompleteAccessTaskResponseDto } from "./dto/mock-complete-access-task.dto.js";
import { AccessTaskExecutorService } from "./access-task-executor.service.js";

@ApiTags("Access Tasks")
@Controller("access-tasks")
export class AccessTasksController {
  constructor(
    private readonly accessTasksService: AccessTasksService,
    private readonly accessTaskExecutorService: AccessTaskExecutorService
  ) {}

  @Post(":id/mock-complete")
  @ApiOperation({ summary: "Mock-complete an access task" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Access task mock-completed.", type: MockCompleteAccessTaskResponseDto })
  @ApiBadRequestResponse({ description: "Invalid mock completion payload." })
  @ApiNotFoundResponse({ description: "Access task not found." })
  mockCompleteAccessTask(
    @Param("id") id: string,
    @Body() body: MockCompleteAccessTaskDto
  ): Promise<MockCompleteAccessTaskResult> {
    return this.accessTasksService.mockCompleteAccessTask(id, body);
  }

  @Post(":id/execute")
  @ApiOperation({ summary: "Execute an access task" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Access task executed.", type: MockCompleteAccessTaskResponseDto })
  @ApiBadRequestResponse({ description: "Access task cannot be executed." })
  @ApiNotFoundResponse({ description: "Access task not found." })
  executeAccessTask(@Param("id") id: string): Promise<ExecuteAccessTaskResult> {
    return this.accessTaskExecutorService.executeAccessTask(id);
  }

}

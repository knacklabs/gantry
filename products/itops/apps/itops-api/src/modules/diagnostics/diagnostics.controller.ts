import { Controller, Get, Query } from "@nestjs/common";
import { ApiBadRequestResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  ConfigHealthDto,
  ConnectorHealthDto,
  DiagnosticsAuthQueryDto,
  FailedAccessTasksDiagnosticsDto,
  TaskStatusDiagnosticsDto,
  TaskStatusDiagnosticsQueryDto
} from "./dto/diagnostics.dto.js";
import { DiagnosticsService, type ConfigHealth, type ConnectorHealth } from "./diagnostics.service.js";

@ApiTags("Diagnostics")
@Controller("diagnostics")
export class DiagnosticsController {
  constructor(private readonly diagnosticsService: DiagnosticsService) {}

  @Get("config-health")
  @ApiOperation({ summary: "Get redacted configuration health" })
  @ApiOkResponse({ description: "Redacted configuration health returned.", type: ConfigHealthDto })
  @ApiBadRequestResponse({ description: "Invalid diagnostics query." })
  @ApiForbiddenResponse({ description: "Diagnostics are restricted to authorized IT Ops admins." })
  getConfigHealth(@Query() query: DiagnosticsAuthQueryDto): Promise<ConfigHealth> {
    return this.diagnosticsService.getConfigHealth(query);
  }

  @Get("connector-health")
  @ApiOperation({ summary: "Get safe connector health" })
  @ApiOkResponse({ description: "Connector health returned.", type: ConnectorHealthDto })
  @ApiBadRequestResponse({ description: "Invalid diagnostics query." })
  @ApiForbiddenResponse({ description: "Diagnostics are restricted to authorized IT Ops admins." })
  getConnectorHealth(@Query() query: DiagnosticsAuthQueryDto): Promise<ConnectorHealth> {
    return this.diagnosticsService.getConnectorHealth(query);
  }

  @Get("recent-failed-access-tasks")
  @ApiOperation({ summary: "Get recent failed access tasks with sanitized error summaries" })
  @ApiOkResponse({ description: "Recent failed access tasks returned.", type: FailedAccessTasksDiagnosticsDto })
  @ApiBadRequestResponse({ description: "Invalid diagnostics query." })
  @ApiForbiddenResponse({ description: "Diagnostics are restricted to authorized IT Ops admins." })
  getRecentFailedAccessTasks(@Query() query: DiagnosticsAuthQueryDto): Promise<FailedAccessTasksDiagnosticsDto> {
    return this.diagnosticsService.getRecentFailedAccessTasks(query);
  }

  @Get("task-status")
  @ApiOperation({ summary: "Get access task status by employee name or work email" })
  @ApiOkResponse({ description: "Employee task status returned.", type: TaskStatusDiagnosticsDto })
  @ApiBadRequestResponse({ description: "Invalid diagnostics query." })
  @ApiForbiddenResponse({ description: "Diagnostics are restricted to authorized IT Ops admins." })
  getTaskStatusByEmployee(@Query() query: TaskStatusDiagnosticsQueryDto): Promise<TaskStatusDiagnosticsDto> {
    return this.diagnosticsService.getTaskStatusByEmployee(query);
  }
}

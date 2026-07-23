import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ACCESS_RESOURCE_KEY, ACCESS_RESOURCE_TYPE, ACCESS_TASK_OPERATION, ROLE_KEY, SYSTEM_KEY } from "@itops/db";

import { formatZodIssues, isUuid } from "../../common/validation.js";
import {
  AccessTasksRepository,
  type AccessTaskExecutionContext,
  type MockCompleteAccessTaskResult
} from "./access-tasks.repository.js";
import { mockCompleteAccessTaskSchema } from "./dto/mock-complete-access-task.dto.js";

@Injectable()
export class AccessTasksService {
  constructor(private readonly accessTasksRepository: AccessTasksRepository) {}

  async mockCompleteAccessTask(id: string, input: unknown): Promise<MockCompleteAccessTaskResult> {
    if (!isUuid(id)) {
      throw new NotFoundException("Access task not found.");
    }

    const parsed = mockCompleteAccessTaskSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid mock complete access task payload.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    const context = await this.accessTasksRepository.findExecutionContextByTaskId(id);

    if (!context) {
      throw new NotFoundException("Access task not found.");
    }

    if (context.task.operation !== ACCESS_TASK_OPERATION.grant) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Only grant access tasks can be mock-completed to activate access grants."
      });
    }

    const externalAccountId = resolveMockCompletionExternalAccountId({
      context,
      externalAccountId: parsed.data.externalAccountId
    });

    return this.accessTasksRepository.mockCompleteAccessTask({
      context,
      completedByExternalUserId: parsed.data.completedByExternalUserId,
      externalAccountId,
      externalResult: parsed.data.externalResult
    });
  }
}

function resolveMockCompletionExternalAccountId(input: {
  context: AccessTaskExecutionContext;
  externalAccountId?: string | null;
}): string | null {
  if (input.externalAccountId) {
    return input.externalAccountId;
  }

  if (
    input.context.task.connector === SYSTEM_KEY.slack &&
    input.context.system.key === SYSTEM_KEY.slack
  ) {
    if (
      input.context.resource.key === ACCESS_RESOURCE_KEY.workspaceMembership &&
      input.context.resource.resourceType === ACCESS_RESOURCE_TYPE.workspace &&
      input.context.role.key === ROLE_KEY.member
    ) {
      return `manual:slack-workspace:${input.context.accessRequest.employeeId}`;
    }

    return `manual:${input.context.accessRequest.employeeId}:${input.context.resource.key}`;
  }

  throw new BadRequestException({
    statusCode: 400,
    error: "Bad Request",
    message: "externalAccountId is required for non-Slack mock completion."
  });
}

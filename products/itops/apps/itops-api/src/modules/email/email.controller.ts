import { Controller, Get, Param } from "@nestjs/common";
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import { EmailMessageDto } from "./dto/email-message.dto.js";
import { EmailReadService, type SafeEmailMessage } from "./email-read.service.js";

@ApiTags("Email Messages")
@Controller("email-messages")
export class EmailController {
  constructor(private readonly emailReadService: EmailReadService) {}

  @Get(":id")
  @ApiOperation({ summary: "Get email message status by id" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Email message returned.", type: EmailMessageDto })
  @ApiNotFoundResponse({ description: "Email message not found." })
  findEmailMessageById(@Param("id") id: string): Promise<SafeEmailMessage> {
    return this.emailReadService.findEmailMessageById(id);
  }
}

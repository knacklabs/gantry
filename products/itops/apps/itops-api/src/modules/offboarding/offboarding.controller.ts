import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags
} from "@nestjs/swagger";

import {
  DecideOffboardingIntakeDto,
  DecideOffboardingIntakeResponseDto
} from "./dto/decide-offboarding-intake.dto.js";
import {
  CreateOffboardingIntakeDto,
  CreateOffboardingIntakeResponseDto,
  OffboardingIntakeDetailDto
} from "./dto/create-offboarding-intake.dto.js";
import {
  type CreateOffboardingIntakeResult,
  type AutoProcessOffboardingResult,
  type OffboardingIntakeDetail,
  type PublicFinalizeOffboardingResult,
  type PublicOffboardingStatusResult,
  OffboardingService
} from "./offboarding.service.js";
import type { DecideOffboardingIntakeResult } from "./offboarding.repository.js";
import { OffboardingStatusResponseDto } from "./dto/offboarding-status.dto.js";

@ApiTags("Offboarding")
@Controller("offboarding-intakes")
export class OffboardingController {
  constructor(private readonly offboardingService: OffboardingService) {}

  @Post()
  @ApiOperation({ summary: "Create an offboarding intake" })
  @ApiCreatedResponse({ description: "Offboarding intake created.", type: CreateOffboardingIntakeResponseDto })
  @ApiBadRequestResponse({ description: "Invalid offboarding intake payload." })
  @ApiNotFoundResponse({ description: "Employee not found." })
  @ApiConflictResponse({ description: "Employee is already offboarded." })
  createOffboardingIntake(@Body() body: CreateOffboardingIntakeDto): Promise<CreateOffboardingIntakeResult> {
    return this.offboardingService.createOffboardingIntake(body);
  }

  @Post("auto-process")
  @ApiOperation({ summary: "Create, authorize, execute, and finalize offboarding when possible" })
  @ApiCreatedResponse({ description: "Offboarding intake auto-processed.", type: CreateOffboardingIntakeResponseDto })
  @ApiBadRequestResponse({ description: "Invalid offboarding intake payload." })
  @ApiNotFoundResponse({ description: "Employee not found." })
  @ApiConflictResponse({ description: "Offboarding cannot be processed from current state." })
  autoProcessOffboarding(@Body() body: CreateOffboardingIntakeDto): Promise<AutoProcessOffboardingResult> {
    return this.offboardingService.autoProcessOffboarding(body);
  }

  @Get(":id/status")
  @ApiOperation({ summary: "Get offboarding status and revoke progress" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Offboarding status returned.", type: OffboardingStatusResponseDto })
  @ApiNotFoundResponse({ description: "Offboarding intake not found." })
  getOffboardingStatus(@Param("id") id: string): Promise<PublicOffboardingStatusResult> {
    return this.offboardingService.getOffboardingStatus(id);
  }

  @Post(":id/finalize")
  @ApiOperation({ summary: "Finalize an offboarding intake after revoke tasks complete" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Offboarding finalized.", type: OffboardingStatusResponseDto })
  @ApiNotFoundResponse({ description: "Offboarding intake not found." })
  @ApiConflictResponse({ description: "Offboarding intake cannot be finalized yet." })
  finalizeOffboarding(@Param("id") id: string): Promise<PublicFinalizeOffboardingResult> {
    return this.offboardingService.finalizeOffboarding(id);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get offboarding intake by id" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ description: "Offboarding intake returned.", type: OffboardingIntakeDetailDto })
  @ApiNotFoundResponse({ description: "Offboarding intake not found." })
  findOffboardingIntakeById(@Param("id") id: string): Promise<OffboardingIntakeDetail> {
    return this.offboardingService.findOffboardingIntakeById(id);
  }

  @Post(":id/decision")
  @ApiOperation({ summary: "Approve or reject an offboarding intake" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiCreatedResponse({ description: "Offboarding intake decision recorded.", type: DecideOffboardingIntakeResponseDto })
  @ApiBadRequestResponse({ description: "Invalid offboarding intake decision payload." })
  @ApiNotFoundResponse({ description: "Offboarding intake not found." })
  @ApiForbiddenResponse({ description: "Approver is not authorized by policy." })
  @ApiConflictResponse({ description: "Offboarding intake cannot be decided." })
  decideOffboardingIntake(
    @Param("id") id: string,
    @Body() body: DecideOffboardingIntakeDto
  ): Promise<DecideOffboardingIntakeResult> {
    return this.offboardingService.decideOffboardingIntake(id, body);
  }
}

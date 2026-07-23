import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags
} from "@nestjs/swagger";

import { CreateSlackOnboardingIntakeDto } from "./dto/create-slack-onboarding-intake.dto.js";
import { DecideOnboardingIntakeDto } from "./dto/decide-onboarding-intake.dto.js";
import {
  OnboardingService,
  type AutoProcessOnboardingFromSlackMessageResult,
  type ContinueOnboardingSetupResult,
  type CreateSlackOnboardingIntakeResult,
  type DecideOnboardingIntakeResult,
  type FinalizeOnboardingResult,
  type FinalizeOnboardingByEmployeeResult,
  type ListOnboardingIntakesResult,
  type ListOnboardingWorkQueueResult,
  type ListPendingOnboardingSetupsResult,
  type OnboardingIntakeStatusChangeResult,
  type OnboardingStatusResult,
  type ProcessOnboardingIntakeResult,
  type ResolveOnboardingIntakeResult
} from "./onboarding.service.js";

@ApiTags("Onboarding")
@Controller("onboarding-intakes")
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Post("slack")
  @ApiOperation({ summary: "Create onboarding intake from Slack source message" })
  @ApiCreatedResponse({ description: "Onboarding intake created or returned idempotently." })
  @ApiBadRequestResponse({ description: "Invalid payload or non-New Joiner Alert message." })
  createSlackOnboardingIntake(
    @Body() body: CreateSlackOnboardingIntakeDto
  ): Promise<CreateSlackOnboardingIntakeResult> {
    return this.onboardingService.createSlackOnboardingIntake(body);
  }

  @Post("slack/auto-process")
  @ApiOperation({ summary: "Create, authorize, and continue onboarding from Slack source message" })
  @ApiCreatedResponse({ description: "Onboarding intake auto-processed or returned idempotently." })
  @ApiBadRequestResponse({ description: "Invalid payload or non-New Joiner Alert message." })
  @ApiConflictResponse({ description: "Onboarding setup cannot be continued." })
  autoProcessSlackOnboardingIntake(
    @Body() body: CreateSlackOnboardingIntakeDto
  ): Promise<AutoProcessOnboardingFromSlackMessageResult> {
    return this.onboardingService.autoProcessSlackOnboardingIntake(body);
  }

  @Get()
  @ApiOperation({ summary: "List onboarding intakes" })
  @ApiCreatedResponse({ description: "Onboarding intakes matching the filter." })
  listOnboardingIntakes(
    @Query("status") status?: string,
    @Query("limit") limit?: string
  ): Promise<ListOnboardingIntakesResult> {
    return this.onboardingService.listOnboardingIntakes({
      status,
      limit: limit ? Number(limit) : undefined
    });
  }

  @Get("pending-setups")
  @ApiOperation({ summary: "List pending onboarding setup work" })
  @ApiCreatedResponse({ description: "Pending onboarding setup summaries." })
  listPendingOnboardingSetups(
    @Query("limit") limit?: string
  ): Promise<ListPendingOnboardingSetupsResult> {
    return this.onboardingService.listPendingOnboardingSetups({
      limit: limit ? Number(limit) : undefined
    });
  }

  @Get("work-queue")
  @ApiOperation({ summary: "List onboarding work queue" })
  @ApiCreatedResponse({ description: "Onboarding work queue summaries." })
  listOnboardingWorkQueue(
    @Query("limit") limit?: string
  ): Promise<ListOnboardingWorkQueueResult> {
    return this.onboardingService.listOnboardingWorkQueue({
      limit: limit ? Number(limit) : undefined
    });
  }

  @Post("finalize-by-employee")
  @ApiOperation({ summary: "Finalize onboarding by employee or natural fields" })
  @ApiCreatedResponse({ description: "Matching onboarding finalized." })
  @ApiConflictResponse({ description: "Matching onboarding cannot be finalized." })
  finalizeOnboardingByEmployee(@Body() body: unknown): Promise<FinalizeOnboardingByEmployeeResult> {
    return this.onboardingService.finalizeOnboardingByEmployee(body);
  }

  @Post("cancel")
  @ApiOperation({ summary: "Cancel an onboarding intake by id or natural fields" })
  @ApiCreatedResponse({ description: "Matching onboarding intake cancelled." })
  @ApiConflictResponse({ description: "Matching onboarding intake cannot be resolved." })
  cancelOnboardingIntake(@Body() body: unknown): Promise<OnboardingIntakeStatusChangeResult> {
    return this.onboardingService.cancelOnboardingIntake(body);
  }

  @Post("supersede")
  @ApiOperation({ summary: "Supersede an onboarding intake by id or natural fields" })
  @ApiCreatedResponse({ description: "Matching onboarding intake superseded." })
  @ApiConflictResponse({ description: "Matching onboarding intake cannot be resolved." })
  supersedeOnboardingIntake(@Body() body: unknown): Promise<OnboardingIntakeStatusChangeResult> {
    return this.onboardingService.supersedeOnboardingIntake(body);
  }

  @Post("resolve")
  @ApiOperation({ summary: "Resolve an onboarding intake by id or natural fields" })
  @ApiCreatedResponse({ description: "Matching onboarding intake resolved." })
  @ApiConflictResponse({ description: "More than one onboarding intake matches." })
  resolveOnboardingIntake(@Body() body: unknown): Promise<ResolveOnboardingIntakeResult> {
    return this.onboardingService.resolveOnboardingIntake(body);
  }

  @Post(":id/process")
  @ApiOperation({ summary: "Process a valid onboarding intake" })
  @ApiCreatedResponse({ description: "Onboarding intake processed or returned idempotently." })
  @ApiNotFoundResponse({ description: "Onboarding intake not found." })
  @ApiConflictResponse({ description: "Onboarding intake cannot be processed." })
  processOnboardingIntake(@Param("id") id: string): Promise<ProcessOnboardingIntakeResult> {
    return this.onboardingService.processOnboardingIntake(id);
  }

  @Post(":id/decision")
  @ApiOperation({ summary: "Approve or reject an onboarding intake" })
  @ApiCreatedResponse({ description: "Onboarding intake decision recorded." })
  @ApiNotFoundResponse({ description: "Onboarding intake not found." })
  @ApiConflictResponse({ description: "Onboarding intake cannot be decided." })
  @ApiForbiddenResponse({ description: "Approver is not authorized by policy." })
  decideOnboardingIntake(
    @Param("id") id: string,
    @Body() body: DecideOnboardingIntakeDto
  ): Promise<DecideOnboardingIntakeResult> {
    return this.onboardingService.decideOnboardingIntake(id, body);
  }

  @Get(":id/status")
  @ApiOperation({ summary: "Get onboarding setup progress" })
  @ApiCreatedResponse({ description: "Onboarding intake setup status." })
  @ApiNotFoundResponse({ description: "Onboarding intake not found." })
  getOnboardingStatus(@Param("id") id: string): Promise<OnboardingStatusResult> {
    return this.onboardingService.getOnboardingStatus(id);
  }

  @Post(":id/continue-setup")
  @ApiOperation({ summary: "Continue critical onboarding setup tasks" })
  @ApiCreatedResponse({ description: "Critical onboarding setup continued." })
  @ApiNotFoundResponse({ description: "Onboarding intake not found." })
  @ApiConflictResponse({ description: "Onboarding setup cannot be continued." })
  continueOnboardingSetup(@Param("id") id: string): Promise<ContinueOnboardingSetupResult> {
    return this.onboardingService.continueOnboardingSetup(id);
  }

  @Post(":id/finalize")
  @ApiOperation({ summary: "Finalize onboarding after setup tasks complete" })
  @ApiCreatedResponse({ description: "Onboarding finalized." })
  @ApiNotFoundResponse({ description: "Onboarding intake not found." })
  @ApiConflictResponse({ description: "Onboarding intake cannot be finalized." })
  finalizeOnboarding(@Param("id") id: string): Promise<FinalizeOnboardingResult> {
    return this.onboardingService.finalizeOnboarding(id);
  }
}

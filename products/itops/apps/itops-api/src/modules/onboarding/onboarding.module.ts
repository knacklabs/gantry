import { Module } from "@nestjs/common";
import { loadConfig } from "@itops/config";

import { OnboardingController } from "./onboarding.controller.js";
import { OnboardingParserService } from "./onboarding-parser.service.js";
import { OnboardingRepository } from "./onboarding.repository.js";
import { OnboardingService } from "./onboarding.service.js";
import { OnboardingValidationRepository } from "./onboarding-validation.repository.js";
import { OnboardingValidationService } from "./onboarding-validation.service.js";
import { ONBOARDING_SLACK_WORKSPACE_INVITE_MODE } from "./onboarding.tokens.js";
import { AccessTasksModule } from "../access-tasks/access-tasks.module.js";
import { PoliciesModule } from "../policies/policies.module.js";

@Module({
  imports: [AccessTasksModule, PoliciesModule],
  controllers: [OnboardingController],
  providers: [
    OnboardingRepository,
    OnboardingService,
    OnboardingParserService,
    OnboardingValidationRepository,
    OnboardingValidationService,
    {
      provide: ONBOARDING_SLACK_WORKSPACE_INVITE_MODE,
      useFactory: () => loadConfig().slackWorkspaceInvite.mode
    }
  ]
})
export class OnboardingModule {}

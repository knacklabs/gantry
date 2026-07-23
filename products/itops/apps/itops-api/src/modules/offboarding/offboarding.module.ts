import { Module } from "@nestjs/common";

import { OffboardingController } from "./offboarding.controller.js";
import { OffboardingRepository } from "./offboarding.repository.js";
import { OffboardingService } from "./offboarding.service.js";
import { AccessTasksModule } from "../access-tasks/access-tasks.module.js";
import { PoliciesModule } from "../policies/policies.module.js";

@Module({
  imports: [AccessTasksModule, PoliciesModule],
  controllers: [OffboardingController],
  providers: [OffboardingRepository, OffboardingService]
})
export class OffboardingModule {}

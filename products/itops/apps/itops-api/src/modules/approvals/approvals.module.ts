import { Module } from "@nestjs/common";

import { PoliciesModule } from "../policies/policies.module.js";
import { ApprovalsController } from "./approvals.controller.js";
import { ApprovalsRepository } from "./approvals.repository.js";
import { ApprovalsService } from "./approvals.service.js";

@Module({
  imports: [PoliciesModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsRepository, ApprovalsService]
})
export class ApprovalsModule {}

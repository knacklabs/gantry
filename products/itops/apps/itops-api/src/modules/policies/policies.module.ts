import { Module } from "@nestjs/common";

import { ApprovalPolicyService } from "./approval-policy.service.js";

@Module({
  providers: [ApprovalPolicyService],
  exports: [ApprovalPolicyService]
})
export class PoliciesModule {}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ACCESS_REQUEST_STATUS } from "@itops/db";

import { formatZodIssues, isUuid } from "../../common/validation.js";
import {
  ApprovalsRepository,
  type AccessRequestDecision,
} from "./approvals.repository.js";
import { decideAccessRequestSchema } from "./dto/decide-access-request.dto.js";
import { ApprovalPolicyService } from "../policies/approval-policy.service.js";

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly approvalsRepository: ApprovalsRepository,
    private readonly approvalPolicyService: ApprovalPolicyService
  ) { }

  async decideAccessRequest(
    accessRequestId: string,
    input: unknown,
  ): Promise<AccessRequestDecision> {
    if (!isUuid(accessRequestId)) {
      throw new NotFoundException("Access request not found.");
    }

    const parsed = decideAccessRequestSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid access request decision payload.",
        details: formatZodIssues(parsed.error.issues),
      });
    }

    const accessRequest =
      await this.approvalsRepository.findAccessRequestById(accessRequestId);

    if (!accessRequest) {
      throw new NotFoundException("Access request not found.");
    }

    if (accessRequest.status !== ACCESS_REQUEST_STATUS.waitingForApproval) {
      throw new ConflictException(
        "Access request is not waiting for approval.",
      );
    }

    const approvalPolicyDecision = this.approvalPolicyService.canDecideAccessRequest({
      accessRequest,
      approverExternalUserId: parsed.data.approverExternalUserId
    });

    if (!approvalPolicyDecision.allowed) {
      await this.approvalsRepository.recordApprovalDeniedByPolicy({
        accessRequest,
        approverExternalUserId: parsed.data.approverExternalUserId,
        reason: approvalPolicyDecision.reason
      });

      throw new ForbiddenException(`Approval denied by policy: ${approvalPolicyDecision.reason}`);
    }

    return this.approvalsRepository.decideAccessRequest({
      accessRequestId: accessRequest.id,
      ...parsed.data,
    });
  }
}

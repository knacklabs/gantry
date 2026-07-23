import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import {
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_STATUS,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_STATUS,
  APPROVAL_DECISION
} from "@itops/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessRequest, AccessRequestDecision, AccessTask, Approval, ApprovalsRepository } from "./approvals.repository.js";
import { ApprovalsService } from "./approvals.service.js";
import type { ApprovalPolicyService } from "../policies/approval-policy.service.js";

type ApprovalsRepositoryMock = {
  findAccessRequestById: ReturnType<typeof vi.fn>;
  decideAccessRequest: ReturnType<typeof vi.fn>;
  recordApprovalDeniedByPolicy: ReturnType<typeof vi.fn>;
};

type ApprovalPolicyServiceMock = {
  canDecideAccessRequest: ReturnType<typeof vi.fn>;
};

describe("ApprovalsService", () => {
  let repository: ApprovalsRepositoryMock;
  let approvalPolicyService: ApprovalPolicyServiceMock;
  let service: ApprovalsService;

  beforeEach(() => {
    repository = {
      findAccessRequestById: vi.fn(),
      decideAccessRequest: vi.fn(),
      recordApprovalDeniedByPolicy: vi.fn()
    };
    approvalPolicyService = {
      canDecideAccessRequest: vi.fn().mockReturnValue({
        allowed: true,
        reason: "approval policy disabled"
      })
    };

    service = new ApprovalsService(
      repository as unknown as ApprovalsRepository,
      approvalPolicyService as unknown as ApprovalPolicyService
    );
  });

  it("approves a waiting access request", async () => {
    const accessRequest = makeAccessRequest();
    const decision = makeAccessRequestDecision({
      accessRequest: makeAccessRequest({ status: ACCESS_REQUEST_STATUS.approved }),
      approval: makeApproval({ decision: APPROVAL_DECISION.approved }),
      accessTask: makeAccessTask()
    });

    repository.findAccessRequestById.mockResolvedValue(accessRequest);
    repository.decideAccessRequest.mockResolvedValue(decision);

    await expect(
      service.decideAccessRequest(accessRequest.id, {
        decision: APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U999",
        comment: "Approved for onboarding",
        source: "slack",
        gantryConversationId: "conversation-1",
        gantryRuntimeEventId: "event-1"
      })
    ).resolves.toBe(decision);

    expect(repository.decideAccessRequest).toHaveBeenCalledWith({
      accessRequestId: accessRequest.id,
      decision: APPROVAL_DECISION.approved,
      approverExternalUserId: "slack:U999",
      comment: "Approved for onboarding",
      source: "slack",
      gantryConversationId: "conversation-1",
      gantryRuntimeEventId: "event-1"
    });
    expect(approvalPolicyService.canDecideAccessRequest).toHaveBeenCalledWith({
      accessRequest,
      approverExternalUserId: "slack:U999"
    });
  });

  it("rejects a waiting access request and defaults source to slack", async () => {
    const accessRequest = makeAccessRequest();
    const decision = makeAccessRequestDecision({
      accessRequest: makeAccessRequest({ status: ACCESS_REQUEST_STATUS.rejected }),
      approval: makeApproval({ decision: APPROVAL_DECISION.rejected }),
      accessTask: null
    });

    repository.findAccessRequestById.mockResolvedValue(accessRequest);
    repository.decideAccessRequest.mockResolvedValue(decision);

    await expect(
      service.decideAccessRequest(accessRequest.id, {
        decision: APPROVAL_DECISION.rejected,
        approverExternalUserId: "slack:U999",
        comment: "Not needed"
      })
    ).resolves.toBe(decision);

    expect(repository.decideAccessRequest).toHaveBeenCalledWith({
      accessRequestId: accessRequest.id,
      decision: APPROVAL_DECISION.rejected,
      approverExternalUserId: "slack:U999",
      comment: "Not needed",
      source: "slack"
    });
  });

  it("denies an unauthorized approval decision without mutating approval state", async () => {
    const accessRequest = makeAccessRequest();
    repository.findAccessRequestById.mockResolvedValue(accessRequest);
    approvalPolicyService.canDecideAccessRequest.mockReturnValue({
      allowed: false,
      reason: "approver is not authorized"
    });

    await expect(
      service.decideAccessRequest(accessRequest.id, {
        decision: APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U777"
      })
    ).rejects.toMatchObject({
      message: "Approval denied by policy: approver is not authorized"
    });

    expect(repository.recordApprovalDeniedByPolicy).toHaveBeenCalledWith({
      accessRequest,
      approverExternalUserId: "slack:U777",
      reason: "approver is not authorized"
    });
    expect(repository.decideAccessRequest).not.toHaveBeenCalled();
  });

  it("denies self approval without mutating approval state", async () => {
    const accessRequest = makeAccessRequest();
    repository.findAccessRequestById.mockResolvedValue(accessRequest);
    approvalPolicyService.canDecideAccessRequest.mockReturnValue({
      allowed: false,
      reason: "self approval is not allowed"
    });

    await expect(
      service.decideAccessRequest(accessRequest.id, {
        decision: APPROVAL_DECISION.rejected,
        approverExternalUserId: "slack:U123"
      })
    ).rejects.toMatchObject({
      message: "Approval denied by policy: self approval is not allowed"
    });

    expect(repository.recordApprovalDeniedByPolicy).toHaveBeenCalledWith({
      accessRequest,
      approverExternalUserId: "slack:U123",
      reason: "self approval is not allowed"
    });
    expect(repository.decideAccessRequest).not.toHaveBeenCalled();
  });

  it("returns bad request for invalid payloads", async () => {
    await expect(
      service.decideAccessRequest("0a6f04d5-b890-42c7-99e8-e10be81b6ffe", {
        decision: "maybe",
        approverExternalUserId: ""
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.findAccessRequestById).not.toHaveBeenCalled();
    expect(repository.decideAccessRequest).not.toHaveBeenCalled();
    expect(approvalPolicyService.canDecideAccessRequest).not.toHaveBeenCalled();
  });

  it("returns not found for malformed access request ids", async () => {
    await expect(
      service.decideAccessRequest("not-a-uuid", {
        decision: APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U999"
      })
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.findAccessRequestById).not.toHaveBeenCalled();
    expect(approvalPolicyService.canDecideAccessRequest).not.toHaveBeenCalled();
  });

  it("returns not found when access request does not exist", async () => {
    repository.findAccessRequestById.mockResolvedValue(undefined);

    await expect(
      service.decideAccessRequest("0a6f04d5-b890-42c7-99e8-e10be81b6ffe", {
        decision: APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U999"
      })
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.decideAccessRequest).not.toHaveBeenCalled();
    expect(approvalPolicyService.canDecideAccessRequest).not.toHaveBeenCalled();
  });

  it("returns conflict for non-waiting access requests", async () => {
    repository.findAccessRequestById.mockResolvedValue(makeAccessRequest({ status: ACCESS_REQUEST_STATUS.approved }));

    await expect(
      service.decideAccessRequest("0a6f04d5-b890-42c7-99e8-e10be81b6ffe", {
        decision: APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U999"
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.decideAccessRequest).not.toHaveBeenCalled();
    expect(approvalPolicyService.canDecideAccessRequest).not.toHaveBeenCalled();
  });
});

function makeAccessRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
    resourceId: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
    roleId: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
    action: ACCESS_REQUEST_ACTION.grant,
    status: ACCESS_REQUEST_STATUS.waitingForApproval,
    reason: "Create company email during onboarding",
    requestedByExternalUserId: "slack:U123",
    requestedFrom: "api",
    sourceConversationId: null,
    sourceMessageId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "b6ee9937-2bd7-495e-8f6a-790f98a746b5",
    accessRequestId: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
    approverExternalUserId: "slack:U999",
    decision: APPROVAL_DECISION.approved,
    comment: "Approved for onboarding",
    source: "slack",
    gantryConversationId: null,
    gantryRuntimeEventId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeAccessTask(overrides: Partial<AccessTask> = {}): AccessTask {
  return {
    id: "a7f679c4-16eb-40cc-8b16-d45f86717bd7",
    accessRequestId: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
    operation: ACCESS_TASK_OPERATION.grant,
    connector: "google_workspace",
    status: ACCESS_TASK_STATUS.pendingManual,
    idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:google_workspace:company_email:user",
    attemptCount: 0,
    externalResultJson: null,
    errorMessage: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeAccessRequestDecision(overrides: Partial<AccessRequestDecision> = {}): AccessRequestDecision {
  return {
    accessRequest: makeAccessRequest({ status: ACCESS_REQUEST_STATUS.approved }),
    approval: makeApproval(),
    accessTask: makeAccessTask(),
    ...overrides
  };
}

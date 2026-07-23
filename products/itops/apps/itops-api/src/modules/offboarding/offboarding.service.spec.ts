import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  ACCESS_GRANT_STATUS,
  ACCESS_TASK_STATUS,
  EMPLOYEE_STATUS,
  OFFBOARDING_INTAKE_APPROVAL_DECISION,
  OFFBOARDING_INTAKE_STATUS,
  ROLE_RISK_LEVEL
} from "@itops/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActiveAccessPreviewItem,
  DecideOffboardingIntakeResult,
  Employee,
  OffboardingIntake,
  OffboardingIntakeApproval,
  OffboardingRepository,
  OffboardingRevokeItemDetail,
  OffboardingStatusResult
} from "./offboarding.repository.js";
import { OffboardingService } from "./offboarding.service.js";
import type { ApprovalPolicyService } from "../policies/approval-policy.service.js";
import type { AccessTaskExecutorService } from "../access-tasks/access-task-executor.service.js";

type OffboardingRepositoryMock = {
  findEmployeeById: ReturnType<typeof vi.fn>;
  findOffboardingIntakeById: ReturnType<typeof vi.fn>;
  findLatestOffboardingIntakeForEmployee: ReturnType<typeof vi.fn>;
  createOffboardingIntake: ReturnType<typeof vi.fn>;
  listActiveAccessPreviewForEmployee: ReturnType<typeof vi.fn>;
  listRevokeItemsForOffboardingIntake: ReturnType<typeof vi.fn>;
  findApprovedOffboardingIntakeDecision: ReturnType<typeof vi.fn>;
  recordOffboardingApprovalDeniedByPolicy: ReturnType<typeof vi.fn>;
  recordOffboardingTransitionDenied: ReturnType<typeof vi.fn>;
  rejectOffboardingIntake: ReturnType<typeof vi.fn>;
  approveOffboardingIntake: ReturnType<typeof vi.fn>;
  getApprovedOffboardingDecisionState: ReturnType<typeof vi.fn>;
  getOffboardingStatus: ReturnType<typeof vi.fn>;
  finalizeOffboarding: ReturnType<typeof vi.fn>;
};

type ApprovalPolicyServiceMock = {
  canApproveExternalActor: ReturnType<typeof vi.fn>;
};

type AccessTaskExecutorServiceMock = {
  executeAccessTask: ReturnType<typeof vi.fn>;
};

describe("OffboardingService", () => {
  let repository: OffboardingRepositoryMock;
  let approvalPolicyService: ApprovalPolicyServiceMock;
  let accessTaskExecutorService: AccessTaskExecutorServiceMock;
  let service: OffboardingService;

  beforeEach(() => {
    repository = {
      findEmployeeById: vi.fn(),
      findOffboardingIntakeById: vi.fn(),
      findLatestOffboardingIntakeForEmployee: vi.fn(),
      createOffboardingIntake: vi.fn(),
      listActiveAccessPreviewForEmployee: vi.fn(),
      listRevokeItemsForOffboardingIntake: vi.fn(),
      findApprovedOffboardingIntakeDecision: vi.fn(),
      recordOffboardingApprovalDeniedByPolicy: vi.fn(),
      recordOffboardingTransitionDenied: vi.fn(),
      rejectOffboardingIntake: vi.fn(),
      approveOffboardingIntake: vi.fn(),
      getApprovedOffboardingDecisionState: vi.fn(),
      getOffboardingStatus: vi.fn(),
      finalizeOffboarding: vi.fn()
    };
    approvalPolicyService = {
      canApproveExternalActor: vi.fn(() => ({ allowed: true, reason: "approver is authorized" }))
    };
    accessTaskExecutorService = {
      executeAccessTask: vi.fn()
    };

    service = new OffboardingService(
      repository as unknown as OffboardingRepository,
      approvalPolicyService as unknown as ApprovalPolicyService,
      accessTaskExecutorService as unknown as AccessTaskExecutorService
    );
  });

  it("creates an offboarding intake with active access preview", async () => {
    const employee = makeEmployee();
    const activeAccessPreview = [makeActiveAccessPreviewItem()];
    const offboardingIntake = makeOffboardingIntake({ employeeId: employee.id });

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listActiveAccessPreviewForEmployee.mockResolvedValue(activeAccessPreview);
    repository.createOffboardingIntake.mockResolvedValue(offboardingIntake);

    await expect(service.createOffboardingIntake(makePayload({ employeeId: employee.id }))).resolves.toEqual({
      offboardingIntake,
      employee,
      activeAccessPreview,
      activeAccessCount: 1,
      employeeLifecycleCase: "active_offboarding",
      message: "This will start offboarding and revoke active access after approval.",
      nextAction: "approval_required"
    });

    expect(repository.createOffboardingIntake).toHaveBeenCalledWith({
      employeeId: employee.id,
      requestedByExternalUserId: "slack:U123",
      reason: "Resignation",
      lastWorkingDay: "2026-06-30",
      notes: "Offboarding requested from Slack",
      activeAccessCount: 1,
      employeeStatusAtCreation: EMPLOYEE_STATUS.active
    });
  });

  it("creates a preboarding cancellation intake with pre-joining wording", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.preboarding });
    const activeAccessPreview = [makeActiveAccessPreviewItem()];
    const offboardingIntake = makeOffboardingIntake({ employeeId: employee.id });

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listActiveAccessPreviewForEmployee.mockResolvedValue(activeAccessPreview);
    repository.createOffboardingIntake.mockResolvedValue(offboardingIntake);

    await expect(service.createOffboardingIntake(makePayload({ employeeId: employee.id }))).resolves.toEqual({
      offboardingIntake,
      employee,
      activeAccessPreview,
      activeAccessCount: 1,
      employeeLifecycleCase: "preboarding_cancellation",
      message: "This employee is still preboarding. This will cancel onboarding and revoke any access already provisioned.",
      nextAction: "approval_required"
    });

    expect(repository.createOffboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: employee.id,
      employeeStatusAtCreation: EMPLOYEE_STATUS.preboarding
    }));
  });

  it("creates an offboarding intake when the employee has no active access", async () => {
    const employee = makeEmployee();
    const offboardingIntake = makeOffboardingIntake({ employeeId: employee.id });

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listActiveAccessPreviewForEmployee.mockResolvedValue([]);
    repository.createOffboardingIntake.mockResolvedValue(offboardingIntake);

    await expect(service.createOffboardingIntake(makePayload({ employeeId: employee.id }))).resolves.toEqual({
      offboardingIntake,
      employee,
      activeAccessPreview: [],
      activeAccessCount: 0,
      employeeLifecycleCase: "active_offboarding",
      message: "This will start offboarding and revoke active access after approval.",
      nextAction: "approval_required"
    });
  });

  it("auto-processes offboarding using initial-message authority and finalizes when revoke tasks complete", async () => {
    const employee = makeEmployee();
    const activeAccessPreview = [makeActiveAccessPreviewItem()];
    const offboardingIntake = makeOffboardingIntake({ employeeId: employee.id });
    const approvedIntake = makeOffboardingIntake({
      ...offboardingIntake,
      status: OFFBOARDING_INTAKE_STATUS.inProgress
    });
    const revokeItem = makeDecisionRevokeItem();
    const authorityDecision = makeDecisionResult({
      offboardingIntake: approvedIntake,
      revokeItems: [revokeItem],
      decision: makeOffboardingIntakeApproval({
        approverExternalUserId: offboardingIntake.requestedByExternalUserId,
        source: "slack_initial_message_authority",
        comment: "Initial Slack lifecycle message accepted as authority."
      })
    });
    const readyToFinalizeStatus = makeOffboardingStatusResult({
      offboardingIntake: approvedIntake,
      employee: makeEmployee({ status: EMPLOYEE_STATUS.offboarding }),
      revokeItems: [makeStatusRevokeItem({
        accessTaskId: revokeItem.accessTaskId,
        grantStatus: ACCESS_GRANT_STATUS.revoked,
        taskStatus: ACCESS_TASK_STATUS.completed
      })],
      summary: {
        total: 1,
        completed: 1,
        pending: 0,
        failed: 0
      },
      canFinalize: true,
      workflowState: "revoked"
    });
    const finalizedStatus = makeOffboardingStatusResult({
      ...readyToFinalizeStatus,
      offboardingIntake: makeOffboardingIntake({
        ...approvedIntake,
        status: OFFBOARDING_INTAKE_STATUS.completed
      }),
      employee: makeEmployee({ status: EMPLOYEE_STATUS.offboarded }),
      canFinalize: true,
      workflowState: "finalized"
    });

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listActiveAccessPreviewForEmployee.mockResolvedValue(activeAccessPreview);
    repository.createOffboardingIntake.mockResolvedValue(offboardingIntake);
    repository.findOffboardingIntakeById
      .mockResolvedValueOnce(offboardingIntake)
      .mockResolvedValue(approvedIntake);
    repository.findApprovedOffboardingIntakeDecision.mockResolvedValue(undefined);
    repository.approveOffboardingIntake.mockResolvedValue(authorityDecision);
    accessTaskExecutorService.executeAccessTask.mockResolvedValue({
      task: { id: revokeItem.accessTaskId },
      grant: { id: revokeItem.grantId }
    });
    repository.getOffboardingStatus
      .mockResolvedValueOnce(readyToFinalizeStatus)
      .mockResolvedValueOnce(readyToFinalizeStatus);
    repository.finalizeOffboarding.mockResolvedValue(finalizedStatus);

    await expect(service.autoProcessOffboarding(makePayload({ employeeId: employee.id }))).resolves.toMatchObject({
      offboardingIntake: finalizedStatus.offboardingIntake,
      authorityDecision,
      executedTasks: [{ task: { id: revokeItem.accessTaskId } }],
      executionErrors: [],
      finalStatus: {
        offboardingIntake: finalizedStatus.offboardingIntake,
        employee: finalizedStatus.employee,
        workflowState: "finalized"
      },
      finalized: true
    });

    expect(approvalPolicyService.canApproveExternalActor).not.toHaveBeenCalled();
    expect(repository.approveOffboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      approverExternalUserId: "slack:U123",
      source: "slack_initial_message_authority",
      decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved
    }));
    expect(accessTaskExecutorService.executeAccessTask).toHaveBeenCalledWith(revokeItem.accessTaskId);
  });

  it("auto-processes existing offboarding by retrying failed Slack workspace revoke tasks", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const offboardingIntake = makeOffboardingIntake({
      employeeId: employee.id,
      status: OFFBOARDING_INTAKE_STATUS.inProgress
    });
    const failedSlackWorkspaceItem = makeStatusRevokeItem({
      system: {
        id: "11473d86-9339-43c5-8c42-bbf39c3b8d79",
        key: "slack",
        name: "Slack"
      },
      resource: {
        id: "5eb06e97-6450-4f5b-8070-d780673d2024",
        key: "workspace_membership",
        name: "Workspace Membership",
        resourceType: "workspace"
      },
      taskStatus: ACCESS_TASK_STATUS.failed,
      taskErrorMessage: "Slack workspace revoke failed"
    });
    const failedStatus = makeOffboardingStatusResult({
      offboardingIntake,
      employee,
      revokeItems: [failedSlackWorkspaceItem],
      summary: {
        total: 1,
        completed: 0,
        pending: 0,
        failed: 1
      },
      workflowState: "failed"
    });
    const readyToFinalizeStatus = makeOffboardingStatusResult({
      offboardingIntake,
      employee,
      revokeItems: [makeStatusRevokeItem({
        ...failedSlackWorkspaceItem,
        grantStatus: ACCESS_GRANT_STATUS.revoked,
        taskStatus: ACCESS_TASK_STATUS.completed,
        taskErrorMessage: null
      })],
      summary: {
        total: 1,
        completed: 1,
        pending: 0,
        failed: 0
      },
      canFinalize: true,
      workflowState: "revoked"
    });
    const finalizedStatus = makeOffboardingStatusResult({
      ...readyToFinalizeStatus,
      offboardingIntake: makeOffboardingIntake({
        ...offboardingIntake,
        status: OFFBOARDING_INTAKE_STATUS.completed
      }),
      employee: makeEmployee({ status: EMPLOYEE_STATUS.offboarded }),
      workflowState: "finalized"
    });

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.findLatestOffboardingIntakeForEmployee.mockResolvedValue(offboardingIntake);
    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.getOffboardingStatus
      .mockResolvedValueOnce(failedStatus)
      .mockResolvedValueOnce(readyToFinalizeStatus)
      .mockResolvedValueOnce(readyToFinalizeStatus);
    accessTaskExecutorService.executeAccessTask.mockResolvedValue({
      task: { id: failedSlackWorkspaceItem.accessTaskId },
      grant: { id: failedSlackWorkspaceItem.accessGrantId }
    });
    repository.finalizeOffboarding.mockResolvedValue(finalizedStatus);

    await expect(service.autoProcessOffboarding(makePayload({ employeeId: employee.id }))).resolves.toMatchObject({
      authorityDecision: null,
      executedTasks: [{ task: { id: failedSlackWorkspaceItem.accessTaskId } }],
      executionErrors: [],
      finalStatus: {
        workflowState: "finalized"
      },
      finalized: true
    });

    expect(accessTaskExecutorService.executeAccessTask).toHaveBeenCalledWith(failedSlackWorkspaceItem.accessTaskId);
    expect(repository.approveOffboardingIntake).not.toHaveBeenCalled();
  });

  it("returns no_change for offboarded employees", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarded });

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.findLatestOffboardingIntakeForEmployee.mockResolvedValue(undefined);

    await expect(service.createOffboardingIntake(makePayload({ employeeId: employee.id }))).resolves.toEqual({
      offboardingIntake: null,
      employee,
      activeAccessPreview: [],
      activeAccessCount: 0,
      employeeLifecycleCase: "already_offboarded",
      message: "No change. Employee is already offboarded.",
      nextAction: "no_change"
    });

    expect(repository.recordOffboardingTransitionDenied).not.toHaveBeenCalled();
    expect(repository.listActiveAccessPreviewForEmployee).not.toHaveBeenCalled();
    expect(repository.createOffboardingIntake).not.toHaveBeenCalled();
  });

  it("returns existing status for employees already offboarding", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const offboardingIntake = makeOffboardingIntake({
      employeeId: employee.id,
      status: OFFBOARDING_INTAKE_STATUS.inProgress
    });
    const status = makeOffboardingStatusResult({
      offboardingIntake,
      employee
    });

    repository.findEmployeeById.mockResolvedValue(employee);
    repository.findLatestOffboardingIntakeForEmployee.mockResolvedValue(offboardingIntake);
    repository.getOffboardingStatus.mockResolvedValue(status);

    await expect(service.createOffboardingIntake(makePayload({ employeeId: employee.id }))).resolves.toEqual({
      offboardingIntake,
      employee,
      activeAccessPreview: [],
      activeAccessCount: 0,
      employeeLifecycleCase: "already_offboarding",
      message: "Offboarding is already in progress. Here is the current status.",
      nextAction: "view_existing_status",
      offboardingStatus: {
        offboardingIntake,
        employee,
        summary: status.summary,
        revokeItems: status.revokeItems.map((item) => ({
          id: item.id,
          system: item.system,
          resource: item.resource,
          role: item.role,
          grantStatus: item.grantStatus,
          taskStatus: item.taskStatus,
          accessTaskId: item.accessTaskId
        })),
        canFinalize: status.canFinalize,
        workflowState: status.workflowState,
        employeeLifecycleCase: status.employeeLifecycleCase
      }
    });

    expect(repository.listActiveAccessPreviewForEmployee).not.toHaveBeenCalled();
    expect(repository.createOffboardingIntake).not.toHaveBeenCalled();
  });

  it("rejects invalid create payloads", async () => {
    await expect(
      service.createOffboardingIntake({
        employeeId: "not-a-uuid",
        requestedByExternalUserId: ""
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.findEmployeeById).not.toHaveBeenCalled();
  });

  it("returns not found for missing employees", async () => {
    repository.findEmployeeById.mockResolvedValue(undefined);

    await expect(service.createOffboardingIntake(makePayload())).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.listActiveAccessPreviewForEmployee).not.toHaveBeenCalled();
    expect(repository.createOffboardingIntake).not.toHaveBeenCalled();
  });

  it("gets a waiting_for_review intake with current active access preview", async () => {
    const employee = makeEmployee();
    const offboardingIntake = makeOffboardingIntake({ employeeId: employee.id });
    const activeAccessPreview = [makeActiveAccessPreviewItem()];

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listActiveAccessPreviewForEmployee.mockResolvedValue(activeAccessPreview);

    await expect(service.findOffboardingIntakeById(offboardingIntake.id)).resolves.toEqual({
      offboardingIntake,
      employee,
      status: OFFBOARDING_INTAKE_STATUS.waitingForReview,
      activeAccessPreview,
      activeAccessCount: 1,
      revokeItems: []
    });

    expect(repository.listRevokeItemsForOffboardingIntake).not.toHaveBeenCalled();
  });

  it("gets an approved intake with revoke items instead of active access preview", async () => {
    const employee = makeEmployee();
    const offboardingIntake = makeOffboardingIntake({
      employeeId: employee.id,
      status: OFFBOARDING_INTAKE_STATUS.approved
    });
    const revokeItems = [makeRevokeItemDetail()];

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.listRevokeItemsForOffboardingIntake.mockResolvedValue(revokeItems);

    await expect(service.findOffboardingIntakeById(offboardingIntake.id)).resolves.toEqual({
      offboardingIntake,
      employee,
      status: OFFBOARDING_INTAKE_STATUS.approved,
      activeAccessPreview: [],
      activeAccessCount: 0,
      revokeItems
    });

    expect(repository.listActiveAccessPreviewForEmployee).not.toHaveBeenCalled();
  });

  it("returns not found for malformed and missing intake ids", async () => {
    await expect(service.findOffboardingIntakeById("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findOffboardingIntakeById).not.toHaveBeenCalled();

    repository.findOffboardingIntakeById.mockResolvedValue(undefined);

    await expect(service.findOffboardingIntakeById("7c644f93-056a-40bf-815a-9512e050aab5")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("approves an offboarding intake through policy", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const offboardingIntake = makeOffboardingIntake();
    const decision = makeOffboardingIntakeApproval();
    const result = makeDecisionResult({
      offboardingIntake: makeOffboardingIntake({
        status: OFFBOARDING_INTAKE_STATUS.inProgress,
        approvedAt: new Date("2026-06-02T00:00:00.000Z")
      }),
      decision,
      employee,
      revokeItems: [makeDecisionRevokeItem()]
    });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findApprovedOffboardingIntakeDecision.mockResolvedValue(undefined);
    repository.approveOffboardingIntake.mockResolvedValue(result);

    await expect(
      service.decideOffboardingIntake(offboardingIntake.id, {
        decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U_APPROVER",
        comment: "Approved offboarding"
      })
    ).resolves.toEqual(result);

    expect(approvalPolicyService.canApproveExternalActor).toHaveBeenCalledWith({
      requesterExternalUserId: "slack:U123",
      approverExternalUserId: "slack:U_APPROVER"
    });
    expect(repository.approveOffboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      offboardingIntake,
      decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved,
      approverExternalUserId: "slack:U_APPROVER"
    }));
  });

  it("records policy denial and does not decide the intake", async () => {
    const offboardingIntake = makeOffboardingIntake();

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    approvalPolicyService.canApproveExternalActor.mockReturnValue({
      allowed: false,
      reason: "self approval is not allowed"
    });

    await expect(
      service.decideOffboardingIntake(offboardingIntake.id, {
        decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved,
        approverExternalUserId: "U123"
      })
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(repository.recordOffboardingApprovalDeniedByPolicy).toHaveBeenCalledWith({
      offboardingIntake,
      approverExternalUserId: "U123",
      reason: "self approval is not allowed"
    });
    expect(repository.approveOffboardingIntake).not.toHaveBeenCalled();
    expect(repository.rejectOffboardingIntake).not.toHaveBeenCalled();
  });

  it("rejects an offboarding intake without revoke work", async () => {
    const offboardingIntake = makeOffboardingIntake();
    const result = makeDecisionResult({
      offboardingIntake: makeOffboardingIntake({
        status: OFFBOARDING_INTAKE_STATUS.rejected,
        rejectedAt: new Date("2026-06-02T00:00:00.000Z")
      }),
      decision: makeOffboardingIntakeApproval({ decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.rejected }),
      employee: null,
      revokeItems: [],
      nextAction: undefined
    });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.rejectOffboardingIntake.mockResolvedValue(result);

    await expect(
      service.decideOffboardingIntake(offboardingIntake.id, {
        decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.rejected,
        approverExternalUserId: "slack:U_APPROVER"
      })
    ).resolves.toEqual(result);

    expect(repository.rejectOffboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.rejected
    }));
    expect(repository.approveOffboardingIntake).not.toHaveBeenCalled();
  });

  it("does not approve a rejected intake", async () => {
    const offboardingIntake = makeOffboardingIntake({ status: OFFBOARDING_INTAKE_STATUS.rejected });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findApprovedOffboardingIntakeDecision.mockResolvedValue(undefined);

    await expect(
      service.decideOffboardingIntake(offboardingIntake.id, {
        decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U_APPROVER"
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.recordOffboardingTransitionDenied).toHaveBeenCalledWith({
      offboardingIntake,
      actorExternalUserId: "slack:U_APPROVER",
      attemptedAction: "approve_offboarding_intake",
      currentState: "failed",
      reason: "rejected_intake_cannot_be_approved"
    });
    expect(repository.approveOffboardingIntake).not.toHaveBeenCalled();
  });

  it("returns existing approved state idempotently", async () => {
    const offboardingIntake = makeOffboardingIntake({ status: OFFBOARDING_INTAKE_STATUS.inProgress });
    const decision = makeOffboardingIntakeApproval();
    const result = makeDecisionResult({
      offboardingIntake,
      decision,
      revokeItems: [makeDecisionRevokeItem()]
    });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findApprovedOffboardingIntakeDecision.mockResolvedValue(decision);
    repository.approveOffboardingIntake.mockResolvedValue(result);

    await expect(
      service.decideOffboardingIntake(offboardingIntake.id, {
        decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U_APPROVER"
      })
    ).resolves.toEqual(result);

    expect(repository.approveOffboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      offboardingIntake,
      decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved
    }));
  });

  it("returns offboarding status with public revoke progress", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const offboardingIntake = makeOffboardingIntake({
      employeeId: employee.id,
      status: OFFBOARDING_INTAKE_STATUS.inProgress
    });
    const status = makeOffboardingStatusResult({
      offboardingIntake,
      employee,
      summary: {
        total: 2,
        completed: 1,
        pending: 1,
        failed: 0
      },
      revokeItems: [
        makeStatusRevokeItem({ taskStatus: ACCESS_TASK_STATUS.completed, grantStatus: ACCESS_GRANT_STATUS.revoked }),
        makeStatusRevokeItem({ id: "597be1d7-b16f-49c0-ac97-a42555ff7c88", taskStatus: ACCESS_TASK_STATUS.pending })
      ],
      canFinalize: false
    });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.getOffboardingStatus.mockResolvedValue(status);

    await expect(service.getOffboardingStatus(offboardingIntake.id)).resolves.toEqual({
      offboardingIntake,
      employee,
      summary: status.summary,
      revokeItems: status.revokeItems.map((item) => ({
        id: item.id,
        system: item.system,
        resource: item.resource,
        role: item.role,
        grantStatus: item.grantStatus,
        taskStatus: item.taskStatus,
        accessTaskId: item.accessTaskId
      })),
      canFinalize: false,
      workflowState: status.workflowState,
      employeeLifecycleCase: status.employeeLifecycleCase
    });
  });

  it("does not finalize while revoke tasks are still pending", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const offboardingIntake = makeOffboardingIntake({
      employeeId: employee.id,
      status: OFFBOARDING_INTAKE_STATUS.inProgress
    });
    const status = makeOffboardingStatusResult({
      offboardingIntake,
      employee,
      revokeItems: [makeStatusRevokeItem({ taskStatus: ACCESS_TASK_STATUS.pending })],
      canFinalize: false
    });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.getOffboardingStatus.mockResolvedValue(status);

    await expect(service.finalizeOffboarding(offboardingIntake.id)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.recordOffboardingTransitionDenied).toHaveBeenCalledWith({
      offboardingIntake,
      employee,
      actorExternalUserId: "system",
      attemptedAction: "finalize_offboarding",
      currentState: status.workflowState,
      reason: "cannot_finalize_tasks_pending"
    });
    expect(repository.finalizeOffboarding).not.toHaveBeenCalled();
  });

  it("does not finalize when a critical revoke task failed", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const offboardingIntake = makeOffboardingIntake({
      employeeId: employee.id,
      status: OFFBOARDING_INTAKE_STATUS.inProgress
    });
    const status = makeOffboardingStatusResult({
      offboardingIntake,
      employee,
      revokeItems: [makeStatusRevokeItem({
        taskStatus: ACCESS_TASK_STATUS.failed,
        taskErrorMessage: "Slack workspace revoke failed"
      })],
      summary: {
        total: 1,
        completed: 0,
        pending: 0,
        failed: 1
      },
      canFinalize: false,
      workflowState: "failed"
    });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.getOffboardingStatus.mockResolvedValue(status);

    await expect(service.finalizeOffboarding(offboardingIntake.id)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.recordOffboardingTransitionDenied).toHaveBeenCalledWith({
      offboardingIntake,
      employee,
      actorExternalUserId: "system",
      attemptedAction: "finalize_offboarding",
      currentState: "failed",
      reason: "cannot_finalize_task_failed"
    });
    expect(repository.finalizeOffboarding).not.toHaveBeenCalled();
  });

  it("finalizes when all revoke tasks are terminal-success", async () => {
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const offboardingIntake = makeOffboardingIntake({
      employeeId: employee.id,
      status: OFFBOARDING_INTAKE_STATUS.inProgress
    });
    const currentStatus = makeOffboardingStatusResult({
      offboardingIntake,
      employee,
      revokeItems: [
        makeStatusRevokeItem({ taskStatus: ACCESS_TASK_STATUS.completed, grantStatus: ACCESS_GRANT_STATUS.revoked }),
        makeStatusRevokeItem({
          id: "597be1d7-b16f-49c0-ac97-a42555ff7c88",
          taskStatus: ACCESS_TASK_STATUS.skipped,
          grantStatus: ACCESS_GRANT_STATUS.revoked,
          taskErrorMessage: "covered_by_workspace_membership_revoke"
        })
      ],
      summary: {
        total: 2,
        completed: 2,
        pending: 0,
        failed: 0
      },
      canFinalize: true
    });
    const finalizedStatus = makeOffboardingStatusResult({
      ...currentStatus,
      offboardingIntake: makeOffboardingIntake({
        ...offboardingIntake,
        status: OFFBOARDING_INTAKE_STATUS.completed,
        completedAt: new Date("2026-06-02T00:00:00.000Z")
      }),
      employee: makeEmployee({ status: EMPLOYEE_STATUS.offboarded, endDate: "2026-06-30" }),
      canFinalize: true
    });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.getOffboardingStatus.mockResolvedValue(currentStatus);
    repository.finalizeOffboarding.mockResolvedValue(finalizedStatus);

    await expect(service.finalizeOffboarding(offboardingIntake.id)).resolves.toEqual({
      offboardingIntake: finalizedStatus.offboardingIntake,
      employee: finalizedStatus.employee,
      summary: finalizedStatus.summary,
      revokeItems: finalizedStatus.revokeItems.map((item) => ({
        id: item.id,
        system: item.system,
        resource: item.resource,
        role: item.role,
        grantStatus: item.grantStatus,
        taskStatus: item.taskStatus,
        accessTaskId: item.accessTaskId
      })),
      canFinalize: true,
      workflowState: finalizedStatus.workflowState,
      employeeLifecycleCase: finalizedStatus.employeeLifecycleCase
    });
    expect(repository.finalizeOffboarding).toHaveBeenCalledWith({
      offboardingIntake,
      employee
    });
  });

  it("does not finalize from invalid intake statuses", async () => {
    const employee = makeEmployee();
    const offboardingIntake = makeOffboardingIntake({
      employeeId: employee.id,
      status: OFFBOARDING_INTAKE_STATUS.waitingForReview
    });

    repository.findOffboardingIntakeById.mockResolvedValue(offboardingIntake);
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.getOffboardingStatus.mockResolvedValue(makeOffboardingStatusResult({
      offboardingIntake,
      employee,
      workflowState: "waiting_for_approval"
    }));

    await expect(service.finalizeOffboarding(offboardingIntake.id)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.recordOffboardingTransitionDenied).toHaveBeenCalledWith({
      offboardingIntake,
      employee,
      actorExternalUserId: "system",
      attemptedAction: "finalize_offboarding",
      currentState: "waiting_for_approval",
      reason: "waiting_for_approval"
    });
    expect(repository.finalizeOffboarding).not.toHaveBeenCalled();
  });
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    lastWorkingDay: "2026-06-30",
    reason: "Resignation",
    requestedByExternalUserId: "slack:U123",
    notes: "Offboarding requested from Slack",
    ...overrides
  };
}

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    fullName: "Riya Sharma",
    workEmail: "riya.sharma@example.com",
    personalEmail: "riya.personal@example.com",
    contactNo: null,
    employmentType: "fte",
    designation: "Backend Engineer",
    department: "Engineering",
    status: EMPLOYEE_STATUS.active,
    startDate: "2026-06-01",
    endDate: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeOffboardingIntake(overrides: Partial<OffboardingIntake> = {}): OffboardingIntake {
  return {
    id: "7c644f93-056a-40bf-815a-9512e050aab5",
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    requestedByExternalUserId: "slack:U123",
    reason: "Resignation",
    lastWorkingDay: "2026-06-30",
    notes: "Offboarding requested from Slack",
    status: OFFBOARDING_INTAKE_STATUS.waitingForReview,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    approvedAt: null,
    rejectedAt: null,
    completedAt: null,
    ...overrides
  };
}

function makeActiveAccessPreviewItem(overrides: Partial<ActiveAccessPreviewItem> = {}): ActiveAccessPreviewItem {
  return {
    grantId: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
    system: {
      id: "11473d86-9339-43c5-8c42-bbf39c3b8d79",
      key: "slack",
      name: "Slack"
    },
    resource: {
      id: "5eb06e97-6450-4f5b-8070-d780673d2024",
      key: "backend-alerts",
      name: "#backend-alerts",
      resourceType: "channel"
    },
    role: {
      id: "bd8f2db4-b3f6-40c2-8781-bc5bece58f94",
      key: "member",
      name: "Member",
      riskLevel: ROLE_RISK_LEVEL.low
    },
    status: ACCESS_GRANT_STATUS.active,
    ...overrides
  };
}

function makeRevokeItemDetail(overrides: Partial<OffboardingRevokeItemDetail> = {}): OffboardingRevokeItemDetail {
  return {
    id: "33e8b54b-3f65-4f29-9312-7c02892dc8cb",
    accessGrantId: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
    accessRequestId: null,
    accessTaskId: null,
    status: "pending",
    errorMessage: null,
    system: {
      id: "11473d86-9339-43c5-8c42-bbf39c3b8d79",
      key: "slack",
      name: "Slack"
    },
    resource: {
      id: "5eb06e97-6450-4f5b-8070-d780673d2024",
      key: "backend-alerts",
      name: "#backend-alerts",
      resourceType: "channel"
    },
    role: {
      id: "bd8f2db4-b3f6-40c2-8781-bc5bece58f94",
      key: "member",
      name: "Member",
      riskLevel: ROLE_RISK_LEVEL.low
    },
    ...overrides
  };
}

function makeOffboardingIntakeApproval(
  overrides: Partial<OffboardingIntakeApproval> = {}
): OffboardingIntakeApproval {
  return {
    id: "577c4029-f1a7-4c52-bd92-07d017e09a19",
    offboardingIntakeId: "7c644f93-056a-40bf-815a-9512e050aab5",
    approverExternalUserId: "slack:U_APPROVER",
    decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved,
    comment: "Approved offboarding",
    source: "slack",
    gantryConversationId: null,
    gantryRuntimeEventId: null,
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides
  };
}

function makeDecisionRevokeItem() {
  return {
    grantId: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
    accessRequestId: "0ab14c88-6f22-484b-ad51-65d89d6adbbf",
    accessTaskId: "e149bb10-5628-45e7-b59c-07199a76b10a",
    system: {
      id: "11473d86-9339-43c5-8c42-bbf39c3b8d79",
      key: "slack",
      name: "Slack"
    },
    resource: {
      id: "5eb06e97-6450-4f5b-8070-d780673d2024",
      key: "backend-alerts",
      name: "#backend-alerts",
      resourceType: "channel"
    },
    role: {
      id: "bd8f2db4-b3f6-40c2-8781-bc5bece58f94",
      key: "member",
      name: "Member",
      riskLevel: ROLE_RISK_LEVEL.low
    },
    taskStatus: "pending_manual" as const
  };
}

function makeDecisionResult(overrides: Partial<DecideOffboardingIntakeResult> = {}): DecideOffboardingIntakeResult {
  return {
    offboardingIntake: makeOffboardingIntake({ status: OFFBOARDING_INTAKE_STATUS.inProgress }),
    decision: makeOffboardingIntakeApproval(),
    employee: makeEmployee({ status: EMPLOYEE_STATUS.offboarding }),
    revokeItems: [],
    status: OFFBOARDING_INTAKE_STATUS.inProgress,
    nextAction: "execute_revoke_tasks",
    ...overrides
  };
}

function makeStatusRevokeItem(overrides: Partial<OffboardingStatusResult["revokeItems"][number]> = {}): OffboardingStatusResult["revokeItems"][number] {
  return {
    id: "33e8b54b-3f65-4f29-9312-7c02892dc8cb",
    system: {
      id: "11473d86-9339-43c5-8c42-bbf39c3b8d79",
      key: "slack",
      name: "Slack"
    },
    resource: {
      id: "5eb06e97-6450-4f5b-8070-d780673d2024",
      key: "backend-alerts",
      name: "#backend-alerts",
      resourceType: "channel"
    },
    role: {
      id: "bd8f2db4-b3f6-40c2-8781-bc5bece58f94",
      key: "member",
      name: "Member",
      riskLevel: ROLE_RISK_LEVEL.low
    },
    grantStatus: ACCESS_GRANT_STATUS.active,
    taskStatus: ACCESS_TASK_STATUS.pending,
    accessTaskId: "e149bb10-5628-45e7-b59c-07199a76b10a",
    accessGrantId: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
    accessRequestId: "0ab14c88-6f22-484b-ad51-65d89d6adbbf",
    revokeItemStatus: "task_created",
    errorMessage: null,
    taskErrorMessage: null,
    taskExternalResultJson: null,
    ...overrides
  };
}

function makeOffboardingStatusResult(
  overrides: Partial<OffboardingStatusResult> = {}
): OffboardingStatusResult {
  const revokeItems = overrides.revokeItems ?? [makeStatusRevokeItem()];
  return {
    offboardingIntake: makeOffboardingIntake({ status: OFFBOARDING_INTAKE_STATUS.inProgress }),
    employee: makeEmployee({ status: EMPLOYEE_STATUS.offboarding }),
    summary: {
      total: revokeItems.length,
      completed: 0,
      pending: revokeItems.length,
      failed: 0
    },
    revokeItems,
    canFinalize: false,
    workflowState: "revoke_tasks_created",
    employeeLifecycleCase: "active_offboarding",
    ...overrides
  };
}

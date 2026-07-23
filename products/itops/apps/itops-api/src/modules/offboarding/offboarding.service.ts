import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ACCESS_TASK_STATUS,
  AUDIT_ACTOR,
  EMPLOYEE_STATUS,
  OFFBOARDING_INTAKE_APPROVAL_DECISION,
  OFFBOARDING_INTAKE_STATUS
} from "@itops/db";

import { formatZodIssues, isUuid } from "../../common/validation.js";
import {
  type ActiveAccessPreviewItem,
  type DecideOffboardingIntakeResult,
  type Employee,
  type FinalizeOffboardingResult,
  lifecycleCaseForEmployeeStatus,
  type OffboardingIntake,
  type OffboardingStatusResult,
  OffboardingRepository,
  type OffboardingRevokeItemDetail,
  type OffboardingStatusRevokeItem
} from "./offboarding.repository.js";
import { createOffboardingIntakeSchema } from "./dto/create-offboarding-intake.dto.js";
import {
  decideOffboardingIntakeSchema,
  type DecideOffboardingIntakeInput
} from "./dto/decide-offboarding-intake.dto.js";
import { ApprovalPolicyService } from "../policies/approval-policy.service.js";
import { AccessTaskExecutorService } from "../access-tasks/access-task-executor.service.js";
import type { ExecuteAccessTaskResult } from "../access-tasks/access-tasks.repository.js";

export type CreateOffboardingIntakeResult = {
  offboardingIntake: OffboardingIntake | null;
  employee: Employee;
  activeAccessPreview: ActiveAccessPreviewItem[];
  activeAccessCount: number;
  employeeLifecycleCase: "preboarding_cancellation" | "active_offboarding" | "already_offboarding" | "already_offboarded";
  message: string;
  nextAction: "approval_required" | "view_existing_status" | "no_change";
  offboardingStatus?: PublicOffboardingStatusResult;
};

export type OffboardingIntakeDetail = {
  offboardingIntake: OffboardingIntake;
  employee: Employee;
  status: string;
  activeAccessPreview: ActiveAccessPreviewItem[];
  activeAccessCount: number;
  revokeItems: OffboardingRevokeItemDetail[];
};

export type PublicOffboardingStatusRevokeItem = Pick<
  OffboardingStatusRevokeItem,
  "id" | "system" | "resource" | "role" | "grantStatus" | "taskStatus" | "accessTaskId"
>;

export type PublicOffboardingStatusResult = Omit<OffboardingStatusResult, "revokeItems"> & {
  revokeItems: PublicOffboardingStatusRevokeItem[];
};

export type PublicFinalizeOffboardingResult = PublicOffboardingStatusResult;
export type AutoProcessOffboardingResult = CreateOffboardingIntakeResult & {
  authorityDecision: DecideOffboardingIntakeResult | null;
  executedTasks: ExecuteAccessTaskResult[];
  executionErrors: Array<{
    accessTaskId: string;
    message: string;
  }>;
  finalStatus?: PublicOffboardingStatusResult;
  finalized: boolean;
};

@Injectable()
export class OffboardingService {
  constructor(
    private readonly offboardingRepository: OffboardingRepository,
    private readonly approvalPolicyService: ApprovalPolicyService,
    private readonly accessTaskExecutorService: AccessTaskExecutorService
  ) {}

  async createOffboardingIntake(input: unknown): Promise<CreateOffboardingIntakeResult> {
    const parsed = createOffboardingIntakeSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid offboarding intake payload.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    const createInput = parsed.data;
    const employee = await this.offboardingRepository.findEmployeeById(createInput.employeeId);

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    if (employee.status === EMPLOYEE_STATUS.offboarding) {
      const existingIntake = await this.offboardingRepository.findLatestOffboardingIntakeForEmployee({
        employeeId: employee.id,
        statuses: [
          OFFBOARDING_INTAKE_STATUS.waitingForReview,
          OFFBOARDING_INTAKE_STATUS.approved,
          OFFBOARDING_INTAKE_STATUS.inProgress
        ]
      });

      if (existingIntake) {
        const offboardingStatus = await this.offboardingRepository.getOffboardingStatus({
          offboardingIntake: existingIntake,
          employee
        });

        return {
          offboardingIntake: existingIntake,
          employee,
          activeAccessPreview: [],
          activeAccessCount: 0,
          employeeLifecycleCase: "already_offboarding",
          message: "Offboarding is already in progress. Here is the current status.",
          nextAction: "view_existing_status",
          offboardingStatus: toPublicOffboardingStatusResult(offboardingStatus)
        };
      }
    }

    if (employee.status === EMPLOYEE_STATUS.offboarded) {
      const existingIntake = await this.offboardingRepository.findLatestOffboardingIntakeForEmployee({
        employeeId: employee.id
      });
      const offboardingStatus = existingIntake
        ? await this.offboardingRepository.getOffboardingStatus({
            offboardingIntake: existingIntake,
            employee
          })
        : undefined;

      return {
        offboardingIntake: existingIntake ?? null,
        employee,
        activeAccessPreview: [],
        activeAccessCount: 0,
        employeeLifecycleCase: "already_offboarded",
        message: "No change. Employee is already offboarded.",
        nextAction: "no_change",
        ...(offboardingStatus ? { offboardingStatus: toPublicOffboardingStatusResult(offboardingStatus) } : {})
      };
    }

    const activeAccessPreview = await this.offboardingRepository.listActiveAccessPreviewForEmployee(employee.id);
    const offboardingIntake = await this.offboardingRepository.createOffboardingIntake({
      employeeId: employee.id,
      requestedByExternalUserId: createInput.requestedByExternalUserId,
      reason: createInput.reason ?? null,
      lastWorkingDay: createInput.lastWorkingDay ?? null,
      notes: createInput.notes ?? null,
      activeAccessCount: activeAccessPreview.length,
      employeeStatusAtCreation: employee.status
    });

    return {
      offboardingIntake,
      employee,
      activeAccessPreview,
      activeAccessCount: activeAccessPreview.length,
      employeeLifecycleCase: lifecycleCaseForEmployeeStatus(employee.status),
      message: messageForCreateOffboardingLifecycle(employee.status),
      nextAction: "approval_required"
    };
  }

  async autoProcessOffboarding(input: unknown): Promise<AutoProcessOffboardingResult> {
    const intakeResult = await this.createOffboardingIntake(input);

    if (!intakeResult.offboardingIntake) {
      return {
        ...intakeResult,
        authorityDecision: null,
        executedTasks: [],
        executionErrors: [],
        finalStatus: intakeResult.offboardingStatus,
        finalized: intakeResult.offboardingStatus?.workflowState === "finalized"
      };
    }

    const authorityDecision = intakeResult.nextAction === "approval_required"
      ? await this.applyOffboardingIntakeDecision(intakeResult.offboardingIntake.id, {
          decision: OFFBOARDING_INTAKE_APPROVAL_DECISION.approved,
          approverExternalUserId: intakeResult.offboardingIntake.requestedByExternalUserId,
          comment: "Initial Slack lifecycle message accepted as authority.",
          source: "slack_initial_message_authority"
        }, { bypassApprovalPolicy: true })
      : null;

    const taskIds = authorityDecision
      ? authorityDecision.revokeItems.map((item) => item.accessTaskId)
      : intakeResult.offboardingStatus?.revokeItems
        .filter(isExecutableOffboardingTask)
        .map((item) => item.accessTaskId)
        .filter((accessTaskId): accessTaskId is string => typeof accessTaskId === "string") ?? [];
    const executedTasks: ExecuteAccessTaskResult[] = [];
    const executionErrors: AutoProcessOffboardingResult["executionErrors"] = [];

    for (const accessTaskId of taskIds) {
      try {
        executedTasks.push(await this.accessTaskExecutorService.executeAccessTask(accessTaskId));
      } catch (error) {
        executionErrors.push({
          accessTaskId,
          message: error instanceof Error ? error.message : "Access task execution failed."
        });
      }
    }

    let finalStatus = await this.getOffboardingStatus(intakeResult.offboardingIntake.id);
    let finalized = finalStatus.workflowState === "finalized";

    if (!finalized && finalStatus.canFinalize) {
      finalStatus = await this.finalizeOffboarding(intakeResult.offboardingIntake.id);
      finalized = true;
    }

    return {
      ...intakeResult,
      offboardingIntake: finalStatus.offboardingIntake,
      employee: finalStatus.employee,
      authorityDecision,
      executedTasks,
      executionErrors,
      finalStatus,
      finalized
    };
  }

  async findOffboardingIntakeById(id: string): Promise<OffboardingIntakeDetail> {
    if (!isUuid(id)) {
      throw new NotFoundException("Offboarding intake not found.");
    }

    const offboardingIntake = await this.offboardingRepository.findOffboardingIntakeById(id);

    if (!offboardingIntake) {
      throw new NotFoundException("Offboarding intake not found.");
    }

    const employee = await this.offboardingRepository.findEmployeeById(offboardingIntake.employeeId);

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    if (offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.waitingForReview) {
      const activeAccessPreview = await this.offboardingRepository.listActiveAccessPreviewForEmployee(employee.id);

      return {
        offboardingIntake,
        employee,
        status: offboardingIntake.status,
        activeAccessPreview,
        activeAccessCount: activeAccessPreview.length,
        revokeItems: []
      };
    }

    const revokeItems = await this.offboardingRepository.listRevokeItemsForOffboardingIntake(offboardingIntake.id);

    return {
      offboardingIntake,
      employee,
      status: offboardingIntake.status,
      activeAccessPreview: [],
      activeAccessCount: 0,
      revokeItems
    };
  }

  async getOffboardingStatus(id: string): Promise<PublicOffboardingStatusResult> {
    const { offboardingIntake, employee } = await this.findOffboardingIntakeAndEmployee(id);
    const status = await this.offboardingRepository.getOffboardingStatus({
      offboardingIntake,
      employee
    });

    return toPublicOffboardingStatusResult(status);
  }

  async finalizeOffboarding(id: string): Promise<PublicFinalizeOffboardingResult> {
    const { offboardingIntake, employee } = await this.findOffboardingIntakeAndEmployee(id);

    if (
      offboardingIntake.status !== OFFBOARDING_INTAKE_STATUS.inProgress &&
      offboardingIntake.status !== OFFBOARDING_INTAKE_STATUS.approved
    ) {
      const status = await this.offboardingRepository.getOffboardingStatus({
        offboardingIntake,
        employee
      });

      await this.offboardingRepository.recordOffboardingTransitionDenied({
        offboardingIntake,
        employee,
        actorExternalUserId: AUDIT_ACTOR.system,
        attemptedAction: "finalize_offboarding",
        currentState: status.workflowState,
        reason: reasonForInvalidFinalizeStatus(offboardingIntake.status)
      });

      throw createOffboardingTransitionConflict({
        message: messageForInvalidFinalizeStatus(status.workflowState),
        reason: reasonForInvalidFinalizeStatus(offboardingIntake.status),
        currentState: status.workflowState
      });
    }

    const currentStatus = await this.offboardingRepository.getOffboardingStatus({
      offboardingIntake,
      employee
    });

    if (!currentStatus.canFinalize) {
      const reason = currentStatus.summary.failed > 0
        ? "cannot_finalize_task_failed"
        : "cannot_finalize_tasks_pending";

      await this.offboardingRepository.recordOffboardingTransitionDenied({
        offboardingIntake,
        employee,
        actorExternalUserId: AUDIT_ACTOR.system,
        attemptedAction: "finalize_offboarding",
        currentState: currentStatus.workflowState,
        reason
      });

      throw createOffboardingTransitionConflict({
        message: currentStatus.summary.failed > 0
          ? "Offboarding cannot be finalized because a revoke task failed."
          : "Offboarding cannot be finalized because revoke tasks are still pending.",
        reason,
        currentState: currentStatus.workflowState,
        pendingItems: currentStatus.revokeItems.filter((item) => (
          item.taskStatus !== "completed" &&
          !(
            item.taskStatus === "skipped" &&
            (
              item.taskErrorMessage === "covered_by_workspace_membership_revoke" ||
              item.taskExternalResultJson?.reason === "covered_by_workspace_membership_revoke"
            )
          )
        ))
      });
    }

    const finalizedStatus = await this.offboardingRepository.finalizeOffboarding({
      offboardingIntake,
      employee
    });

    return toPublicOffboardingStatusResult(finalizedStatus);
  }

  async decideOffboardingIntake(id: string, input: unknown): Promise<DecideOffboardingIntakeResult> {
    if (!isUuid(id)) {
      throw new NotFoundException("Offboarding intake not found.");
    }

    const parsed = decideOffboardingIntakeSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid offboarding intake decision payload.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    return this.applyOffboardingIntakeDecision(id, parsed.data, { bypassApprovalPolicy: false });
  }

  private async applyOffboardingIntakeDecision(
    id: string,
    input: DecideOffboardingIntakeInput,
    options: { bypassApprovalPolicy: boolean }
  ): Promise<DecideOffboardingIntakeResult> {
    const offboardingIntake = await this.offboardingRepository.findOffboardingIntakeById(id);

    if (!offboardingIntake) {
      throw new NotFoundException("Offboarding intake not found.");
    }

    if (!options.bypassApprovalPolicy) {
      const approvalPolicyDecision = this.approvalPolicyService.canApproveExternalActor({
        requesterExternalUserId: offboardingIntake.requestedByExternalUserId,
        approverExternalUserId: input.approverExternalUserId
      });

      if (!approvalPolicyDecision.allowed) {
        await this.offboardingRepository.recordOffboardingApprovalDeniedByPolicy({
          offboardingIntake,
          approverExternalUserId: input.approverExternalUserId,
          reason: approvalPolicyDecision.reason
        });

        throw new ForbiddenException(`Approval denied by policy: ${approvalPolicyDecision.reason}`);
      }
    }

    if (input.decision === OFFBOARDING_INTAKE_APPROVAL_DECISION.rejected) {
      if (offboardingIntake.status !== OFFBOARDING_INTAKE_STATUS.waitingForReview) {
        await this.offboardingRepository.recordOffboardingTransitionDenied({
          offboardingIntake,
          actorExternalUserId: input.approverExternalUserId,
          attemptedAction: "reject_offboarding_intake",
          currentState: stateForOffboardingIntakeStatus(offboardingIntake.status),
          reason: "not_waiting_for_approval"
        });

        throw createOffboardingTransitionConflict({
          message: "Offboarding intake is not waiting for approval.",
          reason: "not_waiting_for_approval",
          currentState: stateForOffboardingIntakeStatus(offboardingIntake.status)
        });
      }

      return this.offboardingRepository.rejectOffboardingIntake({
        offboardingIntake,
        ...input
      });
    }

    const currentApprovedDecision = await this.offboardingRepository.findApprovedOffboardingIntakeDecision(
      offboardingIntake.id
    );

    if (offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.rejected) {
      await this.offboardingRepository.recordOffboardingTransitionDenied({
        offboardingIntake,
        actorExternalUserId: input.approverExternalUserId,
        attemptedAction: "approve_offboarding_intake",
        currentState: "failed",
        reason: "rejected_intake_cannot_be_approved"
      });

      throw createOffboardingTransitionConflict({
        message: "Rejected offboarding intake cannot be approved.",
        reason: "rejected_intake_cannot_be_approved",
        currentState: "failed"
      });
    }

    if (
      offboardingIntake.status !== OFFBOARDING_INTAKE_STATUS.waitingForReview &&
      !(
        currentApprovedDecision &&
        (offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.approved ||
          offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.inProgress)
      )
    ) {
      await this.offboardingRepository.recordOffboardingTransitionDenied({
        offboardingIntake,
        actorExternalUserId: input.approverExternalUserId,
        attemptedAction: "approve_offboarding_intake",
        currentState: stateForOffboardingIntakeStatus(offboardingIntake.status),
        reason: reasonForInvalidApprovalState(offboardingIntake.status)
      });

      throw createOffboardingTransitionConflict({
        message: messageForInvalidApprovalState(offboardingIntake.status),
        reason: reasonForInvalidApprovalState(offboardingIntake.status),
        currentState: stateForOffboardingIntakeStatus(offboardingIntake.status)
      });
    }

    return this.offboardingRepository.approveOffboardingIntake({
      offboardingIntake,
      ...input
    });
  }

  private async findOffboardingIntakeAndEmployee(id: string): Promise<{
    offboardingIntake: OffboardingIntake;
    employee: Employee;
  }> {
    if (!isUuid(id)) {
      throw new NotFoundException("Offboarding intake not found.");
    }

    const offboardingIntake = await this.offboardingRepository.findOffboardingIntakeById(id);

    if (!offboardingIntake) {
      throw new NotFoundException("Offboarding intake not found.");
    }

    const employee = await this.offboardingRepository.findEmployeeById(offboardingIntake.employeeId);

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    return {
      offboardingIntake,
      employee
    };
  }
}

function toPublicOffboardingStatusResult(
  result: OffboardingStatusResult | FinalizeOffboardingResult
): PublicOffboardingStatusResult {
  return {
    offboardingIntake: result.offboardingIntake,
    employee: result.employee,
    summary: result.summary,
    revokeItems: result.revokeItems.map((item) => ({
      id: item.id,
      system: item.system,
      resource: item.resource,
      role: item.role,
      grantStatus: item.grantStatus,
      taskStatus: item.taskStatus,
      accessTaskId: item.accessTaskId
    })),
    canFinalize: result.canFinalize,
    workflowState: result.workflowState,
    employeeLifecycleCase: result.employeeLifecycleCase
  };
}

function isExecutableOffboardingTask(item: PublicOffboardingStatusRevokeItem): boolean {
  const status = item.taskStatus;

  if (
    status === ACCESS_TASK_STATUS.pending ||
    status === ACCESS_TASK_STATUS.pendingManual ||
    status === ACCESS_TASK_STATUS.pendingDependency ||
    status === ACCESS_TASK_STATUS.retrying
  ) {
    return true;
  }

  return status === ACCESS_TASK_STATUS.failed && isRetryableFailedSlackWorkspaceRevokeItem(item);
}

function isRetryableFailedSlackWorkspaceRevokeItem(item: PublicOffboardingStatusRevokeItem): boolean {
  return item.system.key === "slack" &&
    item.resource.key === "workspace_membership" &&
    item.resource.resourceType === "workspace";
}

function messageForCreateOffboardingLifecycle(employeeStatus: string): string {
  if (employeeStatus === EMPLOYEE_STATUS.preboarding) {
    return "This employee is still preboarding. This will cancel onboarding and revoke any access already provisioned.";
  }

  return "This will start offboarding and revoke active access after approval.";
}

function createOffboardingTransitionConflict(input: {
  message: string;
  reason: string;
  currentState: string;
  pendingItems?: unknown[];
}): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message: input.message,
    reason: input.reason,
    currentState: input.currentState,
    ...(input.pendingItems ? { pendingItems: input.pendingItems } : {})
  });
}

function stateForOffboardingIntakeStatus(status: string): string {
  if (status === OFFBOARDING_INTAKE_STATUS.waitingForReview) {
    return "waiting_for_approval";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.completed) {
    return "finalized";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.cancelled) {
    return "cancelled";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.rejected || status === OFFBOARDING_INTAKE_STATUS.failed) {
    return "failed";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.inProgress) {
    return "revoke_tasks_created";
  }

  return status;
}

function reasonForInvalidApprovalState(status: string): string {
  if (status === OFFBOARDING_INTAKE_STATUS.completed) {
    return "already_finalized";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.cancelled) {
    return "cancelled_intake_cannot_be_approved";
  }

  return "not_waiting_for_approval";
}

function messageForInvalidApprovalState(status: string): string {
  if (status === OFFBOARDING_INTAKE_STATUS.completed) {
    return "Offboarding intake is already finalized.";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.cancelled) {
    return "Cancelled offboarding intake cannot be approved.";
  }

  return "Offboarding intake is not waiting for approval.";
}

function reasonForInvalidFinalizeStatus(status: string): string {
  if (status === OFFBOARDING_INTAKE_STATUS.waitingForReview) {
    return "waiting_for_approval";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.completed) {
    return "already_finalized";
  }

  return "invalid_finalize_state";
}

function messageForInvalidFinalizeStatus(workflowState: string): string {
  if (workflowState === "waiting_for_approval") {
    return "Offboarding is waiting for approval. Revoke tasks cannot be finalized yet.";
  }

  if (workflowState === "finalized") {
    return "Offboarding is already finalized.";
  }

  return "Offboarding intake cannot be finalized from its current state.";
}

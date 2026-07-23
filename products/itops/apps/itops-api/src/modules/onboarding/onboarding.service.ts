import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SlackConnectorInterface } from "@itops/connectors";
import { ACCESS_RESOURCE_KEY, ACCESS_RESOURCE_TYPE, ONBOARDING_INTAKE_APPROVAL_DECISION, ONBOARDING_INTAKE_STATUS, SYSTEM_KEY } from "@itops/db";
import { z } from "zod";

import { formatZodIssues, isUuid } from "../../common/validation.js";
import { AccessTaskExecutorService, SLACK_CONNECTOR } from "../access-tasks/access-task-executor.service.js";
import type { ExecuteAccessTaskResult } from "../access-tasks/access-tasks.repository.js";
import { OnboardingParserService } from "./onboarding-parser.service.js";
import {
  type AccessTask,
  type AccessRequest,
  type Employee,
  OnboardingRepository,
  type OnboardingStatus,
  type OnboardingIntakeCandidateSearchInput,
  type OnboardingIntakeApproval,
  type OnboardingIntakeDecision,
  type OnboardingIntake,
  type OnboardingSetupItem,
  type SlackSourceMessage
} from "./onboarding.repository.js";
import {
  createSlackOnboardingIntakeSchema,
  type CreateSlackOnboardingIntakeInput
} from "./dto/create-slack-onboarding-intake.dto.js";
import {
  decideOnboardingIntakeSchema,
  type DecideOnboardingIntakeInput
} from "./dto/decide-onboarding-intake.dto.js";
import { OnboardingValidationService } from "./onboarding-validation.service.js";
import { ApprovalPolicyService } from "../policies/approval-policy.service.js";

export type CreateSlackOnboardingIntakeResult = {
  sourceMessage: SlackSourceMessage;
  onboardingIntake: OnboardingIntake;
  created: boolean;
  valid: boolean;
  validationErrors: string[];
  nextAction: "admin_review_required" | "fix_validation_errors";
};

export type ProcessOnboardingIntakeResult = {
  employee: Employee;
  onboardingIntake: OnboardingIntake;
  googleWorkspaceAccessRequest: AccessRequest;
};

export type DecideOnboardingIntakeResult = OnboardingIntakeDecision;
export type OnboardingStatusResult = OnboardingStatus;
export type FinalizeOnboardingResult = OnboardingStatus;
export type ContinueOnboardingSetupResult = OnboardingStatus & {
  executedTasks: ExecuteAccessTaskResult[];
  executionErrors: Array<{
    accessTaskId: string;
    message: string;
  }>;
  finalized: boolean;
};
export type AutoProcessOnboardingFromSlackMessageResult = Omit<CreateSlackOnboardingIntakeResult, "nextAction"> & {
  authorityDecision: DecideOnboardingIntakeResult | null;
  setup: ContinueOnboardingSetupResult | null;
  nextAction: "fix_validation_errors" | "setup_complete" | "setup_pending";
};
export type PendingOnboardingSetupSummary = {
  onboardingIntake: OnboardingIntake;
  employee: Employee | null;
  pendingCriticalSetup: string[];
};
export type OnboardingWorkQueueItem = OnboardingStatus & {
  category: "needs_correction" | "waiting_approval" | "setup_pending" | "ready_to_finalize" | "blocked";
  validationErrors: string[];
};
export type ListOnboardingIntakesResult = {
  onboardingIntakes: OnboardingIntake[];
  count: number;
};
export type ListPendingOnboardingSetupsResult = {
  pendingSetups: PendingOnboardingSetupSummary[];
  count: number;
};
export type ListOnboardingWorkQueueResult = {
  items: OnboardingWorkQueueItem[];
  count: number;
};
export type FinalizeOnboardingByEmployeeResult = OnboardingStatus & {
  duplicateWarnings: OnboardingIntake[];
};
export type OnboardingIntakeStatusChangeResult = {
  onboardingIntake: OnboardingIntake;
};
export type ResolveOnboardingIntakeResult = {
  onboardingIntake: OnboardingIntake;
};

const naturalOnboardingTargetSchema = z.object({
  onboardingIntakeId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  query: z.string().trim().min(1).max(255).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  workEmail: z.string().email().optional(),
  personalEmail: z.string().email().optional(),
  designation: z.string().trim().min(1).max(180).optional(),
  doj: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  actorExternalUserId: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).max(1000).optional()
});

type NaturalOnboardingTarget = z.infer<typeof naturalOnboardingTargetSchema>;

const resolveOnboardingIntakeSchema = naturalOnboardingTargetSchema.extend({
  status: z.string().trim().min(1).optional()
});

type ResolveOnboardingIntakeInput = z.infer<typeof resolveOnboardingIntakeSchema>;

const CRITICAL_ONBOARDING_SETUP_TARGETS = [
  {
    label: "Google Workspace company email",
    systemKey: SYSTEM_KEY.googleWorkspace,
    resourceKey: ACCESS_RESOURCE_KEY.companyEmail,
    resourceType: ACCESS_RESOURCE_TYPE.account
  },
  {
    label: "Slack workspace membership",
    systemKey: SYSTEM_KEY.slack,
    resourceKey: ACCESS_RESOURCE_KEY.workspaceMembership,
    resourceType: ACCESS_RESOURCE_TYPE.workspace
  }
] as const;

@Injectable()
export class OnboardingService {
  constructor(
    private readonly onboardingRepository: OnboardingRepository,
    private readonly onboardingParserService: OnboardingParserService,
    private readonly onboardingValidationService: OnboardingValidationService,
    private readonly approvalPolicyService: ApprovalPolicyService,
    private readonly accessTaskExecutorService: AccessTaskExecutorService,
    @Inject(SLACK_CONNECTOR)
    private readonly slackConnector: SlackConnectorInterface
  ) {}

  async createSlackOnboardingIntake(input: unknown): Promise<CreateSlackOnboardingIntakeResult> {
    const parsed = createSlackOnboardingIntakeSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid onboarding Slack intake payload.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    const createInput = parsed.data;
    const actorExternalUserId = resolveActorExternalUserId(createInput);
    const sourceMessage = await this.onboardingRepository.upsertSlackSourceMessage({
      workspaceId: createInput.workspaceId,
      channelId: createInput.channelId,
      messageTs: createInput.messageTs,
      threadTs: createInput.threadTs ?? null,
      rawText: createInput.rawText,
      actorExternalUserId
    });

    const parseResult = this.onboardingParserService.parse(createInput.rawText);

    if (parseResult.detectedType !== "new_joiner_alert") {
      throw new BadRequestException("Slack message is not a New Joiner Alert.");
    }

    const parsedFields = await this.resolveSlackChannelIdsInParsedFields(parseResult.fields);
    const validation = await this.onboardingValidationService.validate(parsedFields);
    const existingIntake = await this.onboardingRepository.findOnboardingIntakeBySourceMessageId(sourceMessage.id);

    if (existingIntake) {
      if (existingIntake.status === ONBOARDING_INTAKE_STATUS.validationFailed && validation.valid) {
        const repaired = await this.onboardingRepository.repairValidationFailedOnboardingIntake({
          sourceMessage,
          actorExternalUserId,
          onboardingIntake: existingIntake,
          parsedFields,
          validation
        });

        return toResult({
          ...repaired,
          created: false
        });
      }

      return toResult({
        sourceMessage,
        onboardingIntake: existingIntake
      });
    }

    if (validation.valid && validation.normalized?.personalEmail) {
      const existingOpenIntake = await this.onboardingRepository.findOpenOnboardingIntakeByPersonalEmail(
        validation.normalized.personalEmail
      );

      await this.onboardingRepository.supersedeValidationFailedIntakesByPersonalEmail({
        personalEmail: validation.normalized.personalEmail,
        replacementSourceMessageId: sourceMessage.id,
        actorExternalUserId
      });

      if (existingOpenIntake) {
        return toResult({
          sourceMessage,
          onboardingIntake: existingOpenIntake,
          created: false
        });
      }
    }

    const created = await this.onboardingRepository.createOnboardingIntake({
      sourceMessage,
      actorExternalUserId,
      parsedFields,
      validation
    });

    return toResult({
      ...created,
      created: true
    });
  }

  private async resolveSlackChannelIdsInParsedFields<T extends { slackChannels: string[] }>(fields: T): Promise<T> {
    if (fields.slackChannels.length === 0) {
      return fields;
    }

    const slackChannels = await Promise.all(
      fields.slackChannels.map(async (channel) => this.resolveSlackChannelDisplayName(channel))
    );

    return {
      ...fields,
      slackChannels
    };
  }

  private async resolveSlackChannelDisplayName(channel: string): Promise<string> {
    const normalized = channel.trim().replace(/^#+/u, "");

    if (!isSlackChannelId(normalized)) {
      return channel;
    }

    try {
      const resolved = await this.slackConnector.findChannelById({
        channelId: normalized
      });

      return resolved?.name ?? normalized;
    } catch {
      return normalized;
    }
  }

  async autoProcessSlackOnboardingIntake(input: unknown): Promise<AutoProcessOnboardingFromSlackMessageResult> {
    const intakeResult = await this.createSlackOnboardingIntake(input);

    if (!intakeResult.valid) {
      return {
        ...intakeResult,
        authorityDecision: null,
        setup: null,
        nextAction: "fix_validation_errors"
      };
    }

    if (intakeResult.onboardingIntake.status === ONBOARDING_INTAKE_STATUS.completed) {
      const completedStatus = await this.onboardingRepository.getOnboardingStatus(intakeResult.onboardingIntake);
      const setup = {
        ...completedStatus,
        executedTasks: [],
        executionErrors: [],
        finalized: true
      };

      return {
        ...intakeResult,
        onboardingIntake: setup.onboardingIntake,
        authorityDecision: null,
        setup,
        nextAction: "setup_complete"
      };
    }

    const authorityActorExternalUserId = intakeResult.sourceMessage.senderExternalUserId;

    if (!authorityActorExternalUserId) {
      throw new ConflictException("Onboarding intake source message actor is missing.");
    }

    const authorityDecision = await this.applyOnboardingIntakeDecision(intakeResult.onboardingIntake.id, {
      decision: ONBOARDING_INTAKE_APPROVAL_DECISION.approved,
      approverExternalUserId: authorityActorExternalUserId,
      comment: "Initial Slack lifecycle message accepted as authority.",
      source: "slack_initial_message_authority"
    }, { bypassApprovalPolicy: true });

    const setup = await this.continueOnboardingSetup(authorityDecision.onboardingIntake.id);

    return {
      ...intakeResult,
      onboardingIntake: setup.onboardingIntake,
      authorityDecision,
      setup,
      nextAction: setup.finalized ? "setup_complete" : "setup_pending"
    };
  }

  async processOnboardingIntake(id: string): Promise<ProcessOnboardingIntakeResult> {
    if (!isUuid(id)) {
      throw new NotFoundException("Onboarding intake not found.");
    }

    let onboardingIntake = await this.onboardingRepository.findOnboardingIntakeById(id);

    if (!onboardingIntake) {
      throw new NotFoundException("Onboarding intake not found.");
    }

    if (onboardingIntake.status === "validation_failed") {
      throw new ConflictException({
        statusCode: 409,
        error: "Conflict",
        message: "Onboarding intake has validation errors.",
        validationErrors: validationErrorsFromJson(onboardingIntake.validationErrors)
      });
    }

    if (onboardingIntake.status !== ONBOARDING_INTAKE_STATUS.readyForProvisioning) {
      throw new ConflictException(
        "Onboarding intake is waiting for admin review. Use the onboarding intake decision endpoint."
      );
    }

    const sourceMessage = await this.onboardingRepository.findSlackSourceMessageById(onboardingIntake.sourceMessageId);

    if (!sourceMessage) {
      throw new ConflictException("Onboarding intake source message is missing.");
    }

    const actorExternalUserId = sourceMessage.senderExternalUserId;

    if (!actorExternalUserId) {
      throw new ConflictException("Onboarding intake source message actor is missing.");
    }
    let employee = onboardingIntake.employeeId
      ? await this.onboardingRepository.findEmployeeById(onboardingIntake.employeeId)
      : undefined;

    if (onboardingIntake.employeeId && !employee) {
      throw new ConflictException("Onboarding intake employee is missing.");
    }

    if (!employee) {
      const created = await this.onboardingRepository.createEmployeeForOnboarding({
        onboardingIntake,
        actorExternalUserId
      });
      employee = created.employee;
      onboardingIntake = created.onboardingIntake;
    }

    let googleWorkspaceAccessRequest = onboardingIntake.googleWorkspaceAccessRequestId
      ? await this.onboardingRepository.findAccessRequestById(onboardingIntake.googleWorkspaceAccessRequestId)
      : undefined;

    if (onboardingIntake.googleWorkspaceAccessRequestId && !googleWorkspaceAccessRequest) {
      throw new ConflictException("Onboarding intake Google Workspace access request is missing.");
    }

    if (!googleWorkspaceAccessRequest) {
      const created = await this.onboardingRepository.createGoogleWorkspaceAccessRequestForOnboarding({
        onboardingIntake,
        employee,
        actorExternalUserId
      });
      onboardingIntake = created.onboardingIntake;
      googleWorkspaceAccessRequest = created.accessRequest;
    }

    return {
      employee,
      onboardingIntake,
      googleWorkspaceAccessRequest
    };
  }

  async listOnboardingIntakes(input: {
    status?: string;
    limit?: number;
  } = {}): Promise<ListOnboardingIntakesResult> {
    const statuses = resolveOnboardingIntakeStatuses(input.status);
    const onboardingIntakes = await this.onboardingRepository.listOnboardingIntakes({
      statuses,
      limit: input.limit
    });

    return {
      onboardingIntakes,
      count: onboardingIntakes.length
    };
  }

  async resolveOnboardingIntake(input: unknown): Promise<ResolveOnboardingIntakeResult> {
    const parsed = parseResolveOnboardingIntakeInput(input);

    if (parsed.onboardingIntakeId) {
      return {
        onboardingIntake: await this.findOnboardingIntakeOrThrow(parsed.onboardingIntakeId)
      };
    }

    const onboardingIntakes = await this.onboardingRepository.findOnboardingIntakeCandidates({
      ...toOnboardingIntakeCandidateSearchInput(parsed),
      statuses: resolveOnboardingIntakeStatuses(parsed.status)
    });

    if (onboardingIntakes.length === 0) {
      throw new NotFoundException("No matching onboarding intake was found.");
    }

    if (onboardingIntakes.length > 1) {
      throw new ConflictException("More than one matching onboarding intake was found. Include role, start date, or personal email.");
    }

    return {
      onboardingIntake: onboardingIntakes[0]
    };
  }

  async listPendingOnboardingSetups(input: {
    limit?: number;
  } = {}): Promise<ListPendingOnboardingSetupsResult> {
    const onboardingIntakes = await this.onboardingRepository.listOnboardingIntakes({
      statuses: [
        ONBOARDING_INTAKE_STATUS.approved,
        ONBOARDING_INTAKE_STATUS.readyForProvisioning
      ],
      limit: input.limit
    });
    const pendingSetups: PendingOnboardingSetupSummary[] = [];

    for (const onboardingIntake of onboardingIntakes) {
      const status = await this.onboardingRepository.getOnboardingStatus(onboardingIntake);
      const pendingCriticalSetup = CRITICAL_ONBOARDING_SETUP_TARGETS
        .filter((target) => {
          const item = status.setupItems.find((setupItem) => isOnboardingSetupTarget(setupItem, target));

          return !item || !isCompletedOnboardingSetupItem(item);
        })
        .map((target) => target.label);

      if (pendingCriticalSetup.length > 0) {
        pendingSetups.push({
          onboardingIntake,
          employee: status.employee,
          pendingCriticalSetup
        });
      }
    }

    return {
      pendingSetups,
      count: pendingSetups.length
    };
  }

  async listOnboardingWorkQueue(input: {
    limit?: number;
  } = {}): Promise<ListOnboardingWorkQueueResult> {
    const onboardingIntakes = await this.onboardingRepository.listOnboardingIntakes({
      statuses: [
        ONBOARDING_INTAKE_STATUS.validationFailed,
        ONBOARDING_INTAKE_STATUS.waitingForReview,
        ONBOARDING_INTAKE_STATUS.approved,
        ONBOARDING_INTAKE_STATUS.readyForProvisioning
      ],
      limit: input.limit
    });
    const items: OnboardingWorkQueueItem[] = [];

    for (const onboardingIntake of onboardingIntakes) {
      const status = await this.onboardingRepository.getOnboardingStatus(onboardingIntake);
      const item = toOnboardingWorkQueueItem(status);

      if (item) {
        items.push(item);
      }
    }

    return {
      items,
      count: items.length
    };
  }

  async decideOnboardingIntake(id: string, input: unknown): Promise<DecideOnboardingIntakeResult> {
    if (!isUuid(id)) {
      throw new NotFoundException("Onboarding intake not found.");
    }

    const parsed = decideOnboardingIntakeSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid onboarding intake decision payload.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    return this.applyOnboardingIntakeDecision(id, parsed.data, { bypassApprovalPolicy: false });
  }

  private async applyOnboardingIntakeDecision(
    id: string,
    input: DecideOnboardingIntakeInput,
    options: { bypassApprovalPolicy: boolean }
  ): Promise<DecideOnboardingIntakeResult> {
    const onboardingIntake = await this.onboardingRepository.findOnboardingIntakeById(id);

    if (!onboardingIntake) {
      throw new NotFoundException("Onboarding intake not found.");
    }

    if (onboardingIntake.status === ONBOARDING_INTAKE_STATUS.validationFailed) {
      throw new ConflictException({
        statusCode: 409,
        error: "Conflict",
        message: "Onboarding intake has validation errors.",
        validationErrors: validationErrorsFromJson(onboardingIntake.validationErrors)
      });
    }

    const sourceMessage = await this.onboardingRepository.findSlackSourceMessageById(onboardingIntake.sourceMessageId);

    if (!sourceMessage?.senderExternalUserId) {
      throw new ConflictException("Onboarding intake source message actor is missing.");
    }

    if (!options.bypassApprovalPolicy) {
      const approvalPolicyDecision = this.approvalPolicyService.canApproveExternalActor({
        requesterExternalUserId: sourceMessage.senderExternalUserId,
        approverExternalUserId: input.approverExternalUserId
      });

      if (!approvalPolicyDecision.allowed) {
        await this.onboardingRepository.recordOnboardingApprovalDeniedByPolicy({
          onboardingIntake,
          approverExternalUserId: input.approverExternalUserId,
          reason: approvalPolicyDecision.reason
        });

        throw new ForbiddenException(`Approval denied by policy: ${approvalPolicyDecision.reason}`);
      }
    }

    if (onboardingIntake.status === ONBOARDING_INTAKE_STATUS.rejected) {
      throw new ConflictException("Onboarding intake is already rejected.");
    }

    if (
      onboardingIntake.status === ONBOARDING_INTAKE_STATUS.completed ||
      onboardingIntake.status === ONBOARDING_INTAKE_STATUS.cancelled
    ) {
      throw new ConflictException("Onboarding intake cannot be decided.");
    }

    if (
      input.decision === ONBOARDING_INTAKE_APPROVAL_DECISION.rejected &&
      !isReviewableIntakeStatus(onboardingIntake.status)
    ) {
      throw new ConflictException("Onboarding intake is not waiting for review.");
    }

    const current = await this.resolveCurrentApprovedState(onboardingIntake);

    if (current && input.decision === ONBOARDING_INTAKE_APPROVAL_DECISION.approved) {
      return current;
    }

    if (!isReviewableIntakeStatus(onboardingIntake.status) && !current) {
      throw new ConflictException("Onboarding intake is not waiting for review.");
    }

    return this.onboardingRepository.decideOnboardingIntake({
      onboardingIntake,
      sourceMessage,
      existingEmployee: current?.employee ?? undefined,
      existingAccessRequest: current?.googleWorkspaceAccessRequest ?? undefined,
      existingAccessTask: current?.accessTask ?? undefined,
      ...input
    });
  }

  async getOnboardingStatus(id: string): Promise<OnboardingStatusResult> {
    const onboardingIntake = await this.findOnboardingIntakeOrThrow(id);

    return this.onboardingRepository.getOnboardingStatus(onboardingIntake);
  }

  async continueOnboardingSetup(id: string): Promise<ContinueOnboardingSetupResult> {
    let onboardingIntake = await this.findOnboardingIntakeOrThrow(id);

    if (onboardingIntake.status === ONBOARDING_INTAKE_STATUS.completed) {
      const completedStatus = await this.onboardingRepository.getOnboardingStatus(onboardingIntake);

      return {
        ...completedStatus,
        executedTasks: [],
        executionErrors: [],
        finalized: true
      };
    }

    if (
      onboardingIntake.status === ONBOARDING_INTAKE_STATUS.validationFailed ||
      onboardingIntake.status === ONBOARDING_INTAKE_STATUS.received ||
      onboardingIntake.status === ONBOARDING_INTAKE_STATUS.waitingForReview ||
      onboardingIntake.status === ONBOARDING_INTAKE_STATUS.rejected ||
      onboardingIntake.status === ONBOARDING_INTAKE_STATUS.cancelled
    ) {
      throw new ConflictException("Onboarding intake is not approved for setup.");
    }

    const executedTasks: ExecuteAccessTaskResult[] = [];
    const executionErrors: ContinueOnboardingSetupResult["executionErrors"] = [];

    for (const target of CRITICAL_ONBOARDING_SETUP_TARGETS) {
      onboardingIntake = await this.findOnboardingIntakeOrThrow(id);
      const status = await this.onboardingRepository.getOnboardingStatus(onboardingIntake);
      const item = status.setupItems.find((setupItem) => isOnboardingSetupTarget(setupItem, target));

      if (!item) {
        throw new ConflictException(`Onboarding setup is missing ${target.label}.`);
      }

      if (isCompletedOnboardingSetupItem(item)) {
        continue;
      }

      if (!item.accessTaskId) {
        throw new ConflictException(`${target.label} setup task is not available yet.`);
      }

      try {
        executedTasks.push(await this.accessTaskExecutorService.executeAccessTask(item.accessTaskId));
      } catch (error) {
        executionErrors.push({
          accessTaskId: item.accessTaskId,
          message: error instanceof Error ? error.message : `${target.label} setup failed.`
        });
        break;
      }
    }

    onboardingIntake = await this.findOnboardingIntakeOrThrow(id);
    const statusAfterSetup = await this.onboardingRepository.getOnboardingStatus(onboardingIntake);

    if (statusAfterSetup.onboardingIntake.status === ONBOARDING_INTAKE_STATUS.completed) {
      return {
        ...statusAfterSetup,
        executedTasks,
        executionErrors,
        finalized: true
      };
    }

    if (!statusAfterSetup.canFinalize || executionErrors.length > 0) {
      return {
        ...statusAfterSetup,
        executedTasks,
        executionErrors,
        finalized: false
      };
    }

    const finalizedStatus = await this.finalizeOnboarding(id);

    return {
      ...finalizedStatus,
      executedTasks,
      executionErrors,
      finalized: true
    };
  }

  async finalizeOnboarding(id: string): Promise<FinalizeOnboardingResult> {
    const onboardingIntake = await this.findOnboardingIntakeOrThrow(id);

    if (
      onboardingIntake.status !== ONBOARDING_INTAKE_STATUS.readyForProvisioning &&
      onboardingIntake.status !== ONBOARDING_INTAKE_STATUS.approved
    ) {
      throw new ConflictException("Onboarding intake cannot be finalized from its current status.");
    }

    const currentStatus = await this.onboardingRepository.getOnboardingStatus(onboardingIntake);

    if (!currentStatus.employee) {
      throw new ConflictException("Onboarding intake employee is missing.");
    }

    if (!currentStatus.canFinalize) {
      throw new ConflictException({
        statusCode: 409,
        error: "Conflict",
        message: "Onboarding setup tasks are not complete.",
        summary: currentStatus.summary,
        pendingItems: currentStatus.setupItems
          .filter((item) => item.taskStatus !== "completed" || item.grantStatus !== "active")
          .map((item) => ({
            accessRequestId: item.accessRequestId,
            accessTaskId: item.accessTaskId,
            system: item.system,
            resource: item.resource,
            role: item.role,
            requestStatus: item.requestStatus,
            taskStatus: item.taskStatus,
            grantStatus: item.grantStatus
          }))
      });
    }

    const finalized = await this.onboardingRepository.finalizeOnboarding({
      onboardingIntake,
      employee: currentStatus.employee
    });

    return this.onboardingRepository.getOnboardingStatus(finalized.onboardingIntake);
  }

  async finalizeOnboardingByEmployee(input: unknown): Promise<FinalizeOnboardingByEmployeeResult> {
    const parsed = parseNaturalOnboardingTarget(input);
    const resolved = await this.resolveActionableOnboardingIntake(parsed, {
      requireFinalizable: true
    });
    const finalized = await this.finalizeOnboarding(resolved.onboardingIntake.id);

    return {
      ...finalized,
      duplicateWarnings: resolved.duplicateWarnings
    };
  }

  async cancelOnboardingIntake(input: unknown): Promise<OnboardingIntakeStatusChangeResult> {
    const parsed = parseNaturalOnboardingTarget(input);
    const resolved = await this.resolveOnboardingIntakeForAdminStatusChange(parsed);
    this.assertOnboardingAdminCleanupAuthorized(parsed);
    this.assertOnboardingIntakeCanBeCancelled(resolved);
    const actorExternalUserId = parsed.actorExternalUserId ?? "system:onboarding_admin";

    const onboardingIntake = await this.onboardingRepository.updateOnboardingIntakeStatus({
      onboardingIntake: resolved,
      status: ONBOARDING_INTAKE_STATUS.cancelled,
      actorExternalUserId,
      reason: parsed.reason ?? "cancelled_by_admin"
    });

    return { onboardingIntake };
  }

  async supersedeOnboardingIntake(input: unknown): Promise<OnboardingIntakeStatusChangeResult> {
    const parsed = parseNaturalOnboardingTarget(input);
    const resolved = await this.resolveOnboardingIntakeForAdminStatusChange(parsed);
    this.assertOnboardingAdminCleanupAuthorized(parsed);
    this.assertOnboardingIntakeCanBeSuperseded(resolved);
    const actorExternalUserId = parsed.actorExternalUserId ?? "system:onboarding_admin";

    const onboardingIntake = await this.onboardingRepository.updateOnboardingIntakeStatus({
      onboardingIntake: resolved,
      status: ONBOARDING_INTAKE_STATUS.superseded,
      actorExternalUserId,
      reason: parsed.reason ?? "superseded_by_admin"
    });

    return { onboardingIntake };
  }

  private async resolveActionableOnboardingIntake(
    input: NaturalOnboardingTarget,
    options: {
      requireFinalizable?: boolean;
    } = {}
  ): Promise<{
    onboardingIntake: OnboardingIntake;
    duplicateWarnings: OnboardingIntake[];
  }> {
    if (input.onboardingIntakeId) {
      const onboardingIntake = await this.findOnboardingIntakeOrThrow(input.onboardingIntakeId);
      return {
        onboardingIntake,
        duplicateWarnings: []
      };
    }

    const onboardingIntakes = await this.onboardingRepository.findOnboardingIntakeCandidates({
      ...toOnboardingIntakeCandidateSearchInput(input),
      limit: 200
    });
    const statuses: OnboardingStatus[] = [];

    for (const onboardingIntake of onboardingIntakes) {
      statuses.push(await this.onboardingRepository.getOnboardingStatus(onboardingIntake));
    }

    const matches = statuses.filter((status) => matchesNaturalOnboardingTarget(status, input));
    const actionable = matches
      .filter((status) => !isInactiveOnboardingIntakeStatus(status.onboardingIntake.status))
      .filter((status) => !options.requireFinalizable || status.canFinalize)
      .sort(compareOnboardingStatusForAction);

    if (actionable.length === 0) {
      throw new NotFoundException(
        options.requireFinalizable
          ? "No finalizable onboarding was found for that employee."
          : "No actionable onboarding was found for that employee."
      );
    }

    if (actionable.length > 1 && compareOnboardingStatusForAction(actionable[0], actionable[1]) === 0) {
      throw new ConflictException("More than one matching onboarding workflow was found. Include company email, role, or start date.");
    }

    return {
      onboardingIntake: actionable[0].onboardingIntake,
      duplicateWarnings: statuses
        .map((status) => status.onboardingIntake)
        .filter((onboardingIntake) => isInactiveOnboardingIntakeStatus(onboardingIntake.status))
        .filter((onboardingIntake) => isLikelyDuplicateOnboardingIntake(onboardingIntake, actionable[0].onboardingIntake))
    };
  }

  private async resolveOnboardingIntakeForAdminStatusChange(input: NaturalOnboardingTarget): Promise<OnboardingIntake> {
    if (input.onboardingIntakeId) {
      return this.findOnboardingIntakeOrThrow(input.onboardingIntakeId);
    }

    const onboardingIntakes = await this.onboardingRepository.findOnboardingIntakeCandidates({
      ...toOnboardingIntakeCandidateSearchInput(input),
      limit: 200
    });
    const matches = onboardingIntakes
      .filter((onboardingIntake) => matchesNaturalOnboardingIntake(onboardingIntake, input))
      .sort(compareOnboardingIntakeForAdminCleanup);

    if (matches.length === 0) {
      throw new NotFoundException("No matching onboarding intake was found.");
    }

    if (matches.length > 1 && compareOnboardingIntakeForAdminCleanup(matches[0], matches[1]) === 0) {
      throw new ConflictException("More than one matching onboarding intake was found. Include role, start date, or personal email.");
    }

    return matches[0];
  }

  private async resolveCurrentApprovedState(
    onboardingIntake: OnboardingIntake
  ): Promise<DecideOnboardingIntakeResult | null> {
    if (!onboardingIntake.employeeId || !onboardingIntake.googleWorkspaceAccessRequestId) {
      return null;
    }

    const [decision, employee, googleWorkspaceAccessRequest, accessTask] = await Promise.all([
      this.onboardingRepository.findApprovedOnboardingIntakeDecision(onboardingIntake.id),
      this.onboardingRepository.findEmployeeById(onboardingIntake.employeeId),
      this.onboardingRepository.findAccessRequestById(onboardingIntake.googleWorkspaceAccessRequestId),
      this.onboardingRepository.findAccessTaskByAccessRequestId(onboardingIntake.googleWorkspaceAccessRequestId)
    ]);

    if (!decision || !employee || !googleWorkspaceAccessRequest || !accessTask) {
      return null;
    }

    const slackWorkspaceAccess = await this.onboardingRepository.findSlackWorkspaceMembershipAccessForOnboarding({
      employeeId: employee.id,
      requestedSlackChannels: onboardingIntake.requestedSlackChannels
    });

    return {
      onboardingIntake,
      decision,
      employee,
      googleWorkspaceAccessRequest,
      accessTask,
      slackWorkspaceAccessRequest: slackWorkspaceAccess.accessRequest,
      slackWorkspaceAccessTask: slackWorkspaceAccess.accessTask,
      slackChannelAccessRequests: [],
      slackChannelAccessTasks: [],
      nextAction: "execute_google_workspace_task"
    };
  }

  private async findOnboardingIntakeOrThrow(id: string): Promise<OnboardingIntake> {
    if (!isUuid(id)) {
      throw new NotFoundException("Onboarding intake not found.");
    }

    const onboardingIntake = await this.onboardingRepository.findOnboardingIntakeById(id);

    if (!onboardingIntake) {
      throw new NotFoundException("Onboarding intake not found.");
    }

    return onboardingIntake;
  }

  private assertOnboardingAdminCleanupAuthorized(input: NaturalOnboardingTarget): void {
    if (!input.actorExternalUserId) {
      throw new BadRequestException("actorExternalUserId is required for onboarding cleanup.");
    }

    const approvalPolicyDecision = this.approvalPolicyService.canAccessDiagnostics({
      actorExternalUserId: input.actorExternalUserId
    });

    if (!approvalPolicyDecision.allowed) {
      throw new ForbiddenException(`Onboarding cleanup denied by policy: ${approvalPolicyDecision.reason}`);
    }
  }

  private assertOnboardingIntakeCanBeCancelled(onboardingIntake: OnboardingIntake): void {
    if (hasStartedOnboardingSetup(onboardingIntake)) {
      throw new ConflictException("Onboarding intake already has employee or access setup state and cannot be cancelled by cleanup.");
    }

    if (
      onboardingIntake.status !== ONBOARDING_INTAKE_STATUS.received &&
      onboardingIntake.status !== ONBOARDING_INTAKE_STATUS.waitingForReview &&
      onboardingIntake.status !== ONBOARDING_INTAKE_STATUS.validationFailed
    ) {
      throw new ConflictException("Onboarding intake cannot be cancelled from its current status.");
    }
  }

  private assertOnboardingIntakeCanBeSuperseded(onboardingIntake: OnboardingIntake): void {
    if (hasStartedOnboardingSetup(onboardingIntake)) {
      throw new ConflictException("Onboarding intake already has employee or access setup state and cannot be superseded by cleanup.");
    }

    if (onboardingIntake.status !== ONBOARDING_INTAKE_STATUS.validationFailed) {
      throw new ConflictException("Only validation-failed onboarding intakes can be superseded.");
    }
  }
}

function isReviewableIntakeStatus(status: string): boolean {
  return status === ONBOARDING_INTAKE_STATUS.waitingForReview || status === ONBOARDING_INTAKE_STATUS.received;
}

function isOnboardingSetupTarget(
  item: OnboardingSetupItem,
  target: typeof CRITICAL_ONBOARDING_SETUP_TARGETS[number]
): boolean {
  return (
    item.system.key === target.systemKey &&
    item.resource.key === target.resourceKey &&
    item.resource.resourceType === target.resourceType
  );
}

function isCompletedOnboardingSetupItem(item: OnboardingSetupItem): boolean {
  return item.taskStatus === "completed" && item.grantStatus === "active";
}

function parseNaturalOnboardingTarget(input: unknown): NaturalOnboardingTarget {
  const parsed = naturalOnboardingTargetSchema.safeParse(input);

  if (!parsed.success) {
    throw new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      message: "Invalid onboarding target payload.",
      details: formatZodIssues(parsed.error.issues)
    });
  }

  if (
    !parsed.data.onboardingIntakeId &&
    !parsed.data.employeeId &&
    !parsed.data.query &&
    !parsed.data.name &&
    !parsed.data.workEmail &&
    !parsed.data.personalEmail
  ) {
    throw new BadRequestException("Employee name, company email, personal email, employee id, or onboarding intake id is required.");
  }

  return parsed.data;
}

function parseResolveOnboardingIntakeInput(input: unknown): ResolveOnboardingIntakeInput {
  const parsed = resolveOnboardingIntakeSchema.safeParse(input);

  if (!parsed.success) {
    throw new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      message: "Invalid onboarding resolve payload.",
      details: formatZodIssues(parsed.error.issues)
    });
  }

  if (
    !parsed.data.onboardingIntakeId &&
    !parsed.data.employeeId &&
    !parsed.data.query &&
    !parsed.data.name &&
    !parsed.data.workEmail &&
    !parsed.data.personalEmail
  ) {
    throw new BadRequestException("Employee name, company email, personal email, employee id, or onboarding intake id is required.");
  }

  return parsed.data;
}

function toOnboardingIntakeCandidateSearchInput(
  input: NaturalOnboardingTarget | ResolveOnboardingIntakeInput
): OnboardingIntakeCandidateSearchInput {
  return {
    onboardingIntakeId: input.onboardingIntakeId,
    employeeId: input.employeeId,
    query: input.query,
    name: input.name,
    workEmail: input.workEmail,
    personalEmail: input.personalEmail,
    designation: input.designation,
    doj: input.doj
  };
}

function toOnboardingWorkQueueItem(status: OnboardingStatus): OnboardingWorkQueueItem | null {
  const validationErrors = validationErrorsFromJson(status.onboardingIntake.validationErrors);

  if (status.onboardingIntake.status === ONBOARDING_INTAKE_STATUS.validationFailed) {
    return {
      ...status,
      category: "needs_correction",
      validationErrors
    };
  }

  if (status.onboardingIntake.status === ONBOARDING_INTAKE_STATUS.waitingForReview) {
    return {
      ...status,
      category: "waiting_approval",
      validationErrors
    };
  }

  if (status.canFinalize) {
    return {
      ...status,
      category: "ready_to_finalize",
      validationErrors
    };
  }

  if (
    status.onboardingIntake.status === ONBOARDING_INTAKE_STATUS.approved ||
    status.onboardingIntake.status === ONBOARDING_INTAKE_STATUS.readyForProvisioning
  ) {
    return {
      ...status,
      category: status.summary.failed > 0 ? "blocked" : "setup_pending",
      validationErrors
    };
  }

  return null;
}

function matchesNaturalOnboardingTarget(status: OnboardingStatus, input: NaturalOnboardingTarget): boolean {
  if (input.employeeId && status.employee?.id !== input.employeeId) {
    return false;
  }

  if (input.workEmail && normalizeEmail(status.employee?.workEmail) !== normalizeEmail(input.workEmail)) {
    return false;
  }

  if (input.employeeId || input.workEmail) {
    return true;
  }

  return matchesNaturalOnboardingIntake(status.onboardingIntake, input) ||
    matchesText(status.employee?.fullName, input.query) ||
    matchesText(status.employee?.fullName, input.name);
}

function matchesNaturalOnboardingIntake(onboardingIntake: OnboardingIntake, input: NaturalOnboardingTarget): boolean {
  if (input.personalEmail && normalizeEmail(onboardingIntake.personalEmail) !== normalizeEmail(input.personalEmail)) {
    return false;
  }

  if (input.designation && normalizeText(onboardingIntake.designation) !== normalizeText(input.designation)) {
    return false;
  }

  if (input.doj && onboardingIntake.doj !== input.doj) {
    return false;
  }

  const nameQuery = input.name ?? input.query;
  if (nameQuery && !matchesText(onboardingIntake.name, nameQuery)) {
    return false;
  }

  return Boolean(input.personalEmail || input.designation || input.doj || nameQuery);
}

function compareOnboardingStatusForAction(left: OnboardingStatus, right: OnboardingStatus): number {
  return scoreOnboardingStatusForAction(right) - scoreOnboardingStatusForAction(left);
}

function scoreOnboardingStatusForAction(status: OnboardingStatus): number {
  let score = 0;

  if (status.canFinalize) score += 100;
  if (status.employee?.status === "preboarding") score += 20;
  if (status.onboardingIntake.status === ONBOARDING_INTAKE_STATUS.readyForProvisioning) score += 10;
  if (status.onboardingIntake.status === ONBOARDING_INTAKE_STATUS.approved) score += 8;
  score += status.summary.completed;
  score -= status.summary.failed * 5;

  return score;
}

function compareOnboardingIntakeForAdminCleanup(left: OnboardingIntake, right: OnboardingIntake): number {
  return scoreOnboardingIntakeForAdminCleanup(right) - scoreOnboardingIntakeForAdminCleanup(left);
}

function scoreOnboardingIntakeForAdminCleanup(onboardingIntake: OnboardingIntake): number {
  if (onboardingIntake.status === ONBOARDING_INTAKE_STATUS.validationFailed) return 100;
  if (onboardingIntake.status === ONBOARDING_INTAKE_STATUS.waitingForReview) return 50;
  if (onboardingIntake.status === ONBOARDING_INTAKE_STATUS.cancelled) return -50;
  if (onboardingIntake.status === ONBOARDING_INTAKE_STATUS.superseded) return -100;
  return 0;
}

function isInactiveOnboardingIntakeStatus(status: string): boolean {
  return (
    status === ONBOARDING_INTAKE_STATUS.validationFailed ||
    status === ONBOARDING_INTAKE_STATUS.cancelled ||
    status === ONBOARDING_INTAKE_STATUS.rejected ||
    status === ONBOARDING_INTAKE_STATUS.superseded
  );
}

function isLikelyDuplicateOnboardingIntake(left: OnboardingIntake, right: OnboardingIntake): boolean {
  const leftEmail = normalizeEmail(left.personalEmail);
  const rightEmail = normalizeEmail(right.personalEmail);

  if (leftEmail && rightEmail) {
    return leftEmail === rightEmail;
  }

  return normalizeText(left.name) === normalizeText(right.name) && left.doj === right.doj;
}

function hasStartedOnboardingSetup(onboardingIntake: OnboardingIntake): boolean {
  return Boolean(onboardingIntake.employeeId || onboardingIntake.googleWorkspaceAccessRequestId);
}

function matchesText(value: string | null | undefined, query: string | null | undefined): boolean {
  const normalizedValue = normalizeText(value);
  const normalizedQuery = normalizeText(query);

  return normalizedValue.length > 0 && normalizedQuery.length > 0 && normalizedValue.includes(normalizedQuery);
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isSlackChannelId(value: string): boolean {
  return /^[CG][A-Z0-9]{8,}$/u.test(value);
}

function resolveOnboardingIntakeStatuses(status: string | undefined): string[] {
  if (!status || status === "open") {
    return [
      ONBOARDING_INTAKE_STATUS.waitingForReview,
      ONBOARDING_INTAKE_STATUS.approved,
      ONBOARDING_INTAKE_STATUS.readyForProvisioning
    ];
  }

  if (status === "needs_correction") {
    return [ONBOARDING_INTAKE_STATUS.validationFailed];
  }

  if (status === "pending_review") {
    return [ONBOARDING_INTAKE_STATUS.waitingForReview, ONBOARDING_INTAKE_STATUS.received];
  }

  return [status];
}

function resolveActorExternalUserId(input: CreateSlackOnboardingIntakeInput): string {
  if (input.senderExternalUserId) {
    return input.senderExternalUserId;
  }

  return `slack:${input.senderSlackUserId}`;
}

function toResult(input: {
  sourceMessage: SlackSourceMessage;
  onboardingIntake: OnboardingIntake;
  created?: boolean;
}): CreateSlackOnboardingIntakeResult {
  const validationErrors = validationErrorsFromJson(input.onboardingIntake.validationErrors);

  return {
    sourceMessage: input.sourceMessage,
    onboardingIntake: input.onboardingIntake,
    created: input.created ?? false,
    valid: input.onboardingIntake.status !== "validation_failed",
    validationErrors,
    nextAction: validationErrors.length > 0 ? "fix_validation_errors" : "admin_review_required"
  };
}

function validationErrorsFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

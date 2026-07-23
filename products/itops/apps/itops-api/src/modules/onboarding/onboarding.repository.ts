import { Inject, Injectable } from "@nestjs/common";
import type { SlackWorkspaceInviteMode } from "@itops/config";
import {
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_STATUS,
  ACCESS_RESOURCE_TYPE,
  ACCESS_RESOURCE_KEY,
  ACCESS_GRANT_STATUS,
  accessGrants,
  accessRequests,
  accessResources,
  ACCESS_TASK_STATUS,
  accessTasks,
  APPROVAL_DECISION,
  approvals,
  auditEvents,
  EMPLOYEE_STATUS,
  employees,
  ONBOARDING_INTAKE_APPROVAL_DECISION,
  onboardingIntakeApprovals,
  ONBOARDING_INTAKE_STATUS,
  onboardingIntakes,
  ROLE_KEY,
  roles,
  slackSourceMessages,
  SYSTEM_KEY,
  systems
} from "@itops/db";
import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";
import type { NormalizedOnboardingFields } from "./onboarding-validation.service.js";
import type { CreateSlackOnboardingIntakeInput } from "./dto/create-slack-onboarding-intake.dto.js";
import type { DecideOnboardingIntakeInput } from "./dto/decide-onboarding-intake.dto.js";
import { ONBOARDING_SLACK_WORKSPACE_INVITE_MODE } from "./onboarding.tokens.js";

export type SlackSourceMessage = typeof slackSourceMessages.$inferSelect;
export type OnboardingIntake = typeof onboardingIntakes.$inferSelect;
export type OnboardingIntakeApproval = typeof onboardingIntakeApprovals.$inferSelect;
export type Employee = typeof employees.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type AccessTask = typeof accessTasks.$inferSelect;
export type AccessResource = typeof accessResources.$inferSelect;

type Transaction = Parameters<Parameters<DatabaseProvider["db"]["transaction"]>[0]>[0];

export type CreateOnboardingIntakeRepositoryInput = {
  sourceMessage: SlackSourceMessage;
  actorExternalUserId: string;
  parsedFields: {
    name: string | null;
    personalEmail: string | null;
    contactNo: string | null;
    doj: string | null;
    employmentType: "fte" | "contractor" | null;
    designation: string | null;
    laptop: string | null;
    relocation: string | null;
    slackChannels: string[];
  };
  validation: {
    valid: boolean;
    normalized: NormalizedOnboardingFields | null;
    validationErrors: string[];
  };
};

type UpsertSlackSourceMessageInput = Pick<
  CreateSlackOnboardingIntakeInput,
  "workspaceId" | "channelId" | "messageTs" | "threadTs" | "rawText"
> & {
  actorExternalUserId: string;
};

type DecideOnboardingIntakeRepositoryInput = DecideOnboardingIntakeInput & {
  onboardingIntake: OnboardingIntake;
  sourceMessage: SlackSourceMessage;
  existingEmployee?: Employee;
  existingAccessRequest?: AccessRequest;
  existingAccessTask?: AccessTask;
};

export type OnboardingIntakeCandidateSearchInput = {
  onboardingIntakeId?: string;
  employeeId?: string;
  query?: string;
  name?: string;
  workEmail?: string;
  personalEmail?: string;
  designation?: string;
  doj?: string;
  statuses?: string[];
  limit?: number;
};

export type OnboardingIntakeDecision = {
  onboardingIntake: OnboardingIntake;
  decision: OnboardingIntakeApproval;
  employee: Employee | null;
  googleWorkspaceAccessRequest: AccessRequest | null;
  accessTask: AccessTask | null;
  slackWorkspaceAccessRequest: AccessRequest | null;
  slackWorkspaceAccessTask: AccessTask | null;
  slackChannelAccessRequests: AccessRequest[];
  slackChannelAccessTasks: AccessTask[];
  nextAction?: "execute_google_workspace_task";
};

export type OnboardingSetupItem = {
  accessRequestId: string;
  accessTaskId: string | null;
  system: {
    key: string;
    name: string;
  };
  resource: {
    key: string;
    name: string;
    resourceType: string;
  };
  role: {
    key: string;
    name: string;
  };
  requestStatus: string;
  taskStatus: string | null;
  taskErrorMessage: string | null;
  grantStatus: string | null;
  required: boolean;
};

export type OnboardingStatusSummary = {
  total: number;
  completed: number;
  pending: number;
  failed: number;
};

export type OnboardingStatus = {
  onboardingIntake: OnboardingIntake;
  employee: Employee | null;
  summary: OnboardingStatusSummary;
  setupItems: OnboardingSetupItem[];
  canFinalize: boolean;
};

@Injectable()
export class OnboardingRepository {
  constructor(
    private readonly databaseProvider: DatabaseProvider,
    @Inject(ONBOARDING_SLACK_WORKSPACE_INVITE_MODE)
    private readonly slackWorkspaceInviteMode: SlackWorkspaceInviteMode
  ) {}

  async upsertSlackSourceMessage(input: UpsertSlackSourceMessageInput): Promise<SlackSourceMessage> {
    const [sourceMessage] = await this.databaseProvider.db
      .insert(slackSourceMessages)
      .values({
        provider: "slack",
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageTs: input.messageTs,
        threadTs: input.threadTs ?? null,
        senderExternalUserId: input.actorExternalUserId,
        rawText: input.rawText,
        detectedType: "unknown",
        processedStatus: "received"
      })
      .onConflictDoUpdate({
        target: [
          slackSourceMessages.provider,
          slackSourceMessages.workspaceId,
          slackSourceMessages.channelId,
          slackSourceMessages.messageTs
        ],
        set: {
          threadTs: input.threadTs ?? null,
          senderExternalUserId: input.actorExternalUserId,
          rawText: input.rawText,
          updatedAt: new Date()
        }
      })
      .returning();

    return sourceMessage;
  }

  async findOnboardingIntakeBySourceMessageId(sourceMessageId: string): Promise<OnboardingIntake | undefined> {
    const [intake] = await this.databaseProvider.db
      .select()
      .from(onboardingIntakes)
      .where(eq(onboardingIntakes.sourceMessageId, sourceMessageId))
      .limit(1);

    return intake;
  }

  async findOnboardingIntakeById(id: string): Promise<OnboardingIntake | undefined> {
    const [intake] = await this.databaseProvider.db
      .select()
      .from(onboardingIntakes)
      .where(eq(onboardingIntakes.id, id))
      .limit(1);

    return intake;
  }

  async listOnboardingIntakes(input: {
    statuses?: string[];
    limit?: number;
  } = {}): Promise<OnboardingIntake[]> {
    const statuses = input.statuses?.filter(Boolean) ?? [];
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

    return this.databaseProvider.db
      .select()
      .from(onboardingIntakes)
      .where(statuses.length > 0 ? inArray(onboardingIntakes.status, statuses) : undefined)
      .orderBy(desc(onboardingIntakes.createdAt))
      .limit(limit);
  }

  async findOpenOnboardingIntakeByPersonalEmail(personalEmail: string): Promise<OnboardingIntake | undefined> {
    const [intake] = await this.databaseProvider.db
      .select()
      .from(onboardingIntakes)
      .where(
        and(
          eq(onboardingIntakes.personalEmail, personalEmail),
          inArray(onboardingIntakes.status, [
            ONBOARDING_INTAKE_STATUS.received,
            ONBOARDING_INTAKE_STATUS.waitingForReview,
            ONBOARDING_INTAKE_STATUS.approved,
            ONBOARDING_INTAKE_STATUS.readyForProvisioning
          ])
        )
      )
      .orderBy(desc(onboardingIntakes.createdAt))
      .limit(1);

    return intake;
  }

  async findOnboardingIntakeCandidates(input: OnboardingIntakeCandidateSearchInput): Promise<OnboardingIntake[]> {
    const conditions: SQL[] = [];
    const statuses = input.statuses?.filter(Boolean) ?? [];
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 200);

    if (input.onboardingIntakeId) {
      conditions.push(eq(onboardingIntakes.id, input.onboardingIntakeId));
    }

    if (statuses.length > 0) {
      conditions.push(inArray(onboardingIntakes.status, statuses));
    }

    if (input.employeeId) {
      conditions.push(eq(onboardingIntakes.employeeId, input.employeeId));
    }

    if (input.workEmail) {
      conditions.push(ilike(employees.workEmail, input.workEmail));
    }

    if (!input.employeeId && !input.workEmail) {
      if (input.personalEmail) {
        conditions.push(ilike(onboardingIntakes.personalEmail, input.personalEmail));
      }

      if (input.designation) {
        conditions.push(ilike(onboardingIntakes.designation, input.designation));
      }

      if (input.doj) {
        conditions.push(eq(onboardingIntakes.doj, input.doj));
      }

      const nameQuery = input.name ?? input.query;
      if (nameQuery) {
        const pattern = `%${nameQuery}%`;
        const nameCondition = or(
          ilike(onboardingIntakes.name, pattern),
          ilike(employees.fullName, pattern)
        );
        if (nameCondition) {
          conditions.push(nameCondition);
        }
      }
    }

    const rows = await this.databaseProvider.db
      .select({
        onboardingIntake: onboardingIntakes
      })
      .from(onboardingIntakes)
      .leftJoin(employees, eq(onboardingIntakes.employeeId, employees.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(onboardingIntakes.createdAt))
      .limit(limit);

    return rows.map((row) => row.onboardingIntake);
  }

  async supersedeValidationFailedIntakesByPersonalEmail(input: {
    personalEmail: string;
    replacementSourceMessageId: string;
    actorExternalUserId: string;
  }): Promise<OnboardingIntake[]> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const superseded = await tx
        .update(onboardingIntakes)
        .set({
          status: ONBOARDING_INTAKE_STATUS.superseded,
          updatedAt: now
        })
        .where(
          and(
            eq(onboardingIntakes.personalEmail, input.personalEmail),
            eq(onboardingIntakes.status, ONBOARDING_INTAKE_STATUS.validationFailed)
          )
        )
        .returning();

      if (superseded.length > 0) {
        await tx.insert(auditEvents).values(
          superseded.map((onboardingIntake) => ({
            actorExternalUserId: input.actorExternalUserId,
            eventType: "onboarding_intake.superseded",
            entityType: "onboarding_intake",
            entityId: onboardingIntake.id,
            afterJson: onboardingIntake,
            metadataJson: {
              replacement_source_message_id: input.replacementSourceMessageId,
              reason: "corrected_onboarding_alert"
            }
          }))
        );
      }

      return superseded;
    });
  }

  async updateOnboardingIntakeStatus(input: {
    onboardingIntake: OnboardingIntake;
    status: string;
    actorExternalUserId: string;
    reason: string;
  }): Promise<OnboardingIntake> {
    const [onboardingIntake] = await this.databaseProvider.db
      .update(onboardingIntakes)
      .set({
        status: input.status,
        updatedAt: new Date()
      })
      .where(eq(onboardingIntakes.id, input.onboardingIntake.id))
      .returning();

    await this.databaseProvider.db.insert(auditEvents).values({
      actorExternalUserId: input.actorExternalUserId,
      eventType: `onboarding_intake.${input.status}`,
      entityType: "onboarding_intake",
      entityId: onboardingIntake.id,
      beforeJson: input.onboardingIntake,
      afterJson: onboardingIntake,
      metadataJson: {
        reason: input.reason
      }
    });

    return onboardingIntake;
  }

  async repairValidationFailedOnboardingIntake(input: CreateOnboardingIntakeRepositoryInput & {
    onboardingIntake: OnboardingIntake;
  }): Promise<{
    sourceMessage: SlackSourceMessage;
    onboardingIntake: OnboardingIntake;
  }> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [sourceMessage] = await tx
        .update(slackSourceMessages)
        .set({
          detectedType: "new_joiner_alert",
          updatedAt: now
        })
        .where(eq(slackSourceMessages.id, input.sourceMessage.id))
        .returning();

      const intakeValues = toOnboardingIntakeValues(input);
      const [onboardingIntake] = await tx
        .update(onboardingIntakes)
        .set({
          ...intakeValues,
          sourceMessageId: input.sourceMessage.id,
          updatedAt: now
        })
        .where(
          and(
            eq(onboardingIntakes.id, input.onboardingIntake.id),
            eq(onboardingIntakes.status, ONBOARDING_INTAKE_STATUS.validationFailed)
          )
        )
        .returning();

      if (!onboardingIntake) {
        return {
          sourceMessage,
          onboardingIntake: input.onboardingIntake
        };
      }

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "onboarding_intake.reparsed",
        entityType: "onboarding_intake",
        entityId: onboardingIntake.id,
        beforeJson: input.onboardingIntake,
        afterJson: onboardingIntake,
        metadataJson: {
          source_message_id: sourceMessage.id,
          reason: "validation_failed_intake_reparsed"
        }
      });

      return {
        sourceMessage,
        onboardingIntake
      };
    });
  }

  async createOnboardingIntake(input: CreateOnboardingIntakeRepositoryInput): Promise<{
    sourceMessage: SlackSourceMessage;
    onboardingIntake: OnboardingIntake;
  }> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [sourceMessage] = await tx
        .update(slackSourceMessages)
        .set({
          detectedType: "new_joiner_alert",
          updatedAt: now
        })
        .where(eq(slackSourceMessages.id, input.sourceMessage.id))
        .returning();

      const intakeValues = toOnboardingIntakeValues(input);
      const [onboardingIntake] = await tx
        .insert(onboardingIntakes)
        .values(intakeValues)
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "onboarding_intake.created",
        entityType: "onboarding_intake",
        entityId: onboardingIntake.id,
        afterJson: onboardingIntake,
        metadataJson: {
          source_message_id: sourceMessage.id
        }
      });

      return {
        sourceMessage,
        onboardingIntake
      };
    });
  }

  async findSlackSourceMessageById(id: string): Promise<SlackSourceMessage | undefined> {
    const [sourceMessage] = await this.databaseProvider.db
      .select()
      .from(slackSourceMessages)
      .where(eq(slackSourceMessages.id, id))
      .limit(1);

    return sourceMessage;
  }

  async findEmployeeById(id: string): Promise<Employee | undefined> {
    const [employee] = await this.databaseProvider.db.select().from(employees).where(eq(employees.id, id)).limit(1);

    return employee;
  }

  async findAccessRequestById(id: string): Promise<AccessRequest | undefined> {
    const [accessRequest] = await this.databaseProvider.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.id, id))
      .limit(1);

    return accessRequest;
  }

  async findAccessTaskByAccessRequestId(accessRequestId: string): Promise<AccessTask | undefined> {
    const [accessTask] = await this.databaseProvider.db
      .select()
      .from(accessTasks)
      .where(eq(accessTasks.accessRequestId, accessRequestId))
      .limit(1);

    return accessTask;
  }

  async findApprovedOnboardingIntakeDecision(onboardingIntakeId: string): Promise<OnboardingIntakeApproval | undefined> {
    const [decision] = await this.databaseProvider.db
      .select()
      .from(onboardingIntakeApprovals)
      .where(
        and(
          eq(onboardingIntakeApprovals.onboardingIntakeId, onboardingIntakeId),
          eq(onboardingIntakeApprovals.decision, ONBOARDING_INTAKE_APPROVAL_DECISION.approved)
        )
      )
      .limit(1);

    return decision;
  }

  async recordOnboardingApprovalDeniedByPolicy(input: {
    onboardingIntake: OnboardingIntake;
    approverExternalUserId: string;
    reason: string;
  }): Promise<void> {
    await this.databaseProvider.db.insert(auditEvents).values({
      actorExternalUserId: input.approverExternalUserId,
      eventType: "onboarding_intake.approval_denied_by_policy",
      entityType: "onboarding_intake",
      entityId: input.onboardingIntake.id,
      metadataJson: {
        reason: input.reason
      }
    });
  }

  async getOnboardingStatus(onboardingIntake: OnboardingIntake): Promise<OnboardingStatus> {
    const employee = onboardingIntake.employeeId
      ? await this.findEmployeeById(onboardingIntake.employeeId)
      : null;

    if (!employee) {
      return {
        onboardingIntake,
        employee: null,
        summary: {
          total: 0,
          completed: 0,
          pending: 0,
          failed: 0
        },
        setupItems: [],
        canFinalize: false
      };
    }

    const setupItems = await this.listOnboardingSetupItems(employee.id);
    const requiredCompleteness = getRequiredOnboardingSetupCompleteness(onboardingIntake, setupItems);
    const summary = summarizeOnboardingSetupItems(setupItems, requiredCompleteness.missingRequiredCount);

    return {
      onboardingIntake,
      employee,
      summary,
      setupItems,
      canFinalize:
        requiredCompleteness.missingRequiredCount === 0 &&
        requiredCompleteness.requiredItems.length > 0 &&
        requiredCompleteness.requiredItems.every(isCompletedOnboardingSetupItem)
    };
  }

  async finalizeOnboarding(input: {
    onboardingIntake: OnboardingIntake;
    employee: Employee;
  }): Promise<{
    onboardingIntake: OnboardingIntake;
    employee: Employee;
  }> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [onboardingIntake] = await tx
        .update(onboardingIntakes)
        .set({
          status: ONBOARDING_INTAKE_STATUS.completed,
          updatedAt: now
        })
        .where(eq(onboardingIntakes.id, input.onboardingIntake.id))
        .returning();

      const [employee] = await tx
        .update(employees)
        .set({
          status: EMPLOYEE_STATUS.active,
          updatedAt: now
        })
        .where(eq(employees.id, input.employee.id))
        .returning();

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: "system:onboarding_finalize",
          eventType: "onboarding.completed",
          entityType: "onboarding_intake",
          entityId: onboardingIntake.id,
          afterJson: onboardingIntake,
          metadataJson: {
            employee_id: employee.id
          }
        },
        {
          actorExternalUserId: "system:onboarding_finalize",
          eventType: "employee.activated",
          entityType: "employee",
          entityId: employee.id,
          afterJson: employee,
          metadataJson: {
            onboarding_intake_id: onboardingIntake.id
          }
        }
      ]);

      return {
        onboardingIntake,
        employee
      };
    });
  }

  private async listOnboardingSetupItems(employeeId: string): Promise<OnboardingSetupItem[]> {
    const rows = await this.databaseProvider.db
      .select({
        accessRequest: accessRequests,
        accessTask: accessTasks,
        accessGrant: accessGrants,
        system: systems,
        resource: accessResources,
        role: roles
      })
      .from(accessRequests)
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessRequests.roleId, roles.id))
      .leftJoin(accessTasks, eq(accessTasks.accessRequestId, accessRequests.id))
      .leftJoin(
        accessGrants,
        and(
          eq(accessGrants.employeeId, accessRequests.employeeId),
          eq(accessGrants.systemId, accessRequests.systemId),
          eq(accessGrants.resourceId, accessRequests.resourceId),
          eq(accessGrants.roleId, accessRequests.roleId)
        )
      )
      .where(
        and(
          eq(accessRequests.employeeId, employeeId),
          eq(accessRequests.action, ACCESS_REQUEST_ACTION.grant),
          eq(accessRequests.requestedFrom, "onboarding_intake")
        )
      )
      .orderBy(desc(accessRequests.createdAt));

    return rows.map((row) => ({
      accessRequestId: row.accessRequest.id,
      accessTaskId: row.accessTask?.id ?? null,
      system: {
        key: row.system.key,
        name: row.system.name
      },
      resource: {
        key: row.resource.key,
        name: row.resource.name,
        resourceType: row.resource.resourceType
      },
      role: {
        key: row.role.key,
        name: row.role.name
      },
      requestStatus: row.accessRequest.status,
      taskStatus: row.accessTask?.status ?? null,
      taskErrorMessage: row.accessTask?.errorMessage ?? null,
      grantStatus: row.accessGrant?.status ?? null,
      required: true
    }));
  }

  async decideOnboardingIntake(input: DecideOnboardingIntakeRepositoryInput): Promise<OnboardingIntakeDecision> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const [decision] = await tx
        .insert(onboardingIntakeApprovals)
        .values({
          onboardingIntakeId: input.onboardingIntake.id,
          approverExternalUserId: input.approverExternalUserId,
          decision: input.decision,
          comment: input.comment ?? null,
          source: input.source,
          gantryConversationId: input.gantryConversationId ?? null,
          gantryRuntimeEventId: input.gantryRuntimeEventId ?? null
        })
        .returning();

      if (input.decision === ONBOARDING_INTAKE_APPROVAL_DECISION.rejected) {
        const [onboardingIntake] = await tx
          .update(onboardingIntakes)
          .set({
            status: ONBOARDING_INTAKE_STATUS.rejected,
            updatedAt: new Date()
          })
          .where(eq(onboardingIntakes.id, input.onboardingIntake.id))
          .returning();

        await tx.insert(auditEvents).values({
          actorExternalUserId: input.approverExternalUserId,
          eventType: "onboarding_intake.rejected",
          entityType: "onboarding_intake",
          entityId: onboardingIntake.id,
          afterJson: onboardingIntake,
          metadataJson: {
            decision_id: decision.id,
            comment: input.comment ?? null
          }
        });

        return {
          onboardingIntake,
          decision,
          employee: null,
          googleWorkspaceAccessRequest: null,
          accessTask: null,
          slackWorkspaceAccessRequest: null,
          slackWorkspaceAccessTask: null,
          slackChannelAccessRequests: [],
          slackChannelAccessTasks: []
        };
      }

      const employee =
        input.existingEmployee ??
        (await this.createEmployeeForOnboardingInTransaction(tx, {
          onboardingIntake: input.onboardingIntake
        }));

      let onboardingIntake = input.existingEmployee
        ? input.onboardingIntake
        : await this.updateOnboardingIntakeAfterEmployeeCreation(tx, {
            onboardingIntakeId: input.onboardingIntake.id,
            employee,
            actorExternalUserId: input.approverExternalUserId
          });

      const accessRequest =
        input.existingAccessRequest ??
        (await this.createGoogleWorkspaceAccessRequestForOnboardingInTransaction(tx, {
          employee,
          requestedByExternalUserId: requireIntakeValue(
            input.sourceMessage.senderExternalUserId,
            "sourceMessage.senderExternalUserId"
          )
        }));

      await this.createOrFindAccessRequestApprovalInTransaction(tx, {
        accessRequest,
        input
      });

      const approvedAccessRequest = await this.approveAccessRequestInTransaction(tx, {
        accessRequest
      });

      const accessTask =
        input.existingAccessTask ??
        (await this.createOrFindAccessTaskInTransaction(tx, {
          accessRequest: approvedAccessRequest,
          actorExternalUserId: input.approverExternalUserId
        }));

      onboardingIntake = await this.updateOnboardingIntakeReadyForProvisioning(tx, {
        onboardingIntakeId: onboardingIntake.id,
        accessRequest: approvedAccessRequest
      });

      const slackWorkspaceAccess = await this.createOrFindSlackWorkspaceMembershipAccessForOnboardingInTransaction(tx, {
        onboardingIntake,
        employee,
        input
      });

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: input.approverExternalUserId,
          eventType: "onboarding_intake.approved",
          entityType: "onboarding_intake",
          entityId: onboardingIntake.id,
          afterJson: onboardingIntake,
          metadataJson: {
            decision_id: decision.id
          }
        },
        {
          actorExternalUserId: input.approverExternalUserId,
          eventType: "onboarding.standard_access_approved",
          entityType: "onboarding_intake",
          entityId: onboardingIntake.id,
          metadataJson: {
            access_request_id: approvedAccessRequest.id,
            access_task_id: accessTask.id
          }
        }
      ]);

      return {
        onboardingIntake,
        decision,
        employee,
        googleWorkspaceAccessRequest: approvedAccessRequest,
        accessTask,
        slackWorkspaceAccessRequest: slackWorkspaceAccess.accessRequest,
        slackWorkspaceAccessTask: slackWorkspaceAccess.accessTask,
        slackChannelAccessRequests: [],
        slackChannelAccessTasks: [],
        nextAction: "execute_google_workspace_task"
      };
    });
  }

  async findOrCreateSlackChannelResource(channelName: string): Promise<AccessResource> {
    return this.databaseProvider.db.transaction(async (tx) =>
      this.findOrCreateSlackChannelResourceInTransaction(tx, channelName)
    );
  }

  async listSlackChannelAccessForOnboarding(input: {
    employeeId: string;
    requestedSlackChannels: unknown;
  }): Promise<{
    accessRequests: AccessRequest[];
    accessTasks: AccessTask[];
  }> {
    const normalizedChannels = normalizeSlackChannelNames(input.requestedSlackChannels);

    if (normalizedChannels.length === 0) {
      return {
        accessRequests: [],
        accessTasks: []
      };
    }

    const slackCatalog = await this.findSlackMemberCatalog();
    const accessRequestsByChannel: AccessRequest[] = [];
    const accessTasksByChannel: AccessTask[] = [];

    for (const channelKey of normalizedChannels) {
      const resource = await this.findSlackChannelResourceByKey(slackCatalog.system.id, channelKey);

      if (!resource) {
        continue;
      }

      const accessRequest = await this.findSlackChannelAccessRequest({
        employeeId: input.employeeId,
        systemId: slackCatalog.system.id,
        resourceId: resource.id,
        roleId: slackCatalog.role.id
      });

      if (!accessRequest) {
        continue;
      }

      const accessTask = await this.findAccessTaskByAccessRequestId(accessRequest.id);

      if (!accessTask) {
        continue;
      }

      accessRequestsByChannel.push(accessRequest);
      accessTasksByChannel.push(accessTask);
    }

    return {
      accessRequests: accessRequestsByChannel,
      accessTasks: accessTasksByChannel
    };
  }

  async findSlackWorkspaceMembershipAccessForOnboarding(input: {
    employeeId: string;
    requestedSlackChannels: unknown;
  }): Promise<{
    accessRequest: AccessRequest | null;
    accessTask: AccessTask | null;
  }> {
    const normalizedChannels = normalizeSlackChannelNames(input.requestedSlackChannels);

    if (normalizedChannels.length === 0) {
      return {
        accessRequest: null,
        accessTask: null
      };
    }

    const slackCatalog = await this.findSlackWorkspaceMembershipCatalog();
    const accessRequest = await this.findSlackWorkspaceMembershipAccessRequest({
      employeeId: input.employeeId,
      systemId: slackCatalog.system.id,
      resourceId: slackCatalog.resource.id,
      roleId: slackCatalog.role.id
    });

    if (!accessRequest) {
      return {
        accessRequest: null,
        accessTask: null
      };
    }

    const accessTask = await this.findAccessTaskByAccessRequestId(accessRequest.id);

    return {
      accessRequest,
      accessTask: accessTask ?? null
    };
  }

  async createEmployeeForOnboarding(input: {
    onboardingIntake: OnboardingIntake;
    actorExternalUserId: string;
  }): Promise<{
    employee: Employee;
    onboardingIntake: OnboardingIntake;
  }> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const [employee] = await tx
        .insert(employees)
        .values({
          fullName: requireIntakeValue(input.onboardingIntake.name, "name"),
          personalEmail: requireIntakeValue(input.onboardingIntake.personalEmail, "personalEmail"),
          workEmail: null,
          contactNo: input.onboardingIntake.contactNo,
          employmentType: requireEmploymentType(input.onboardingIntake.employmentType),
          designation: requireIntakeValue(input.onboardingIntake.designation, "designation"),
          status: EMPLOYEE_STATUS.preboarding,
          startDate: requireIntakeValue(input.onboardingIntake.doj, "doj")
        })
        .returning();

      const [onboardingIntake] = await tx
        .update(onboardingIntakes)
        .set({
          employeeId: employee.id,
          status: ONBOARDING_INTAKE_STATUS.approved,
          updatedAt: new Date()
        })
        .where(eq(onboardingIntakes.id, input.onboardingIntake.id))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "onboarding.employee_created",
        entityType: "onboarding_intake",
        entityId: onboardingIntake.id,
        afterJson: onboardingIntake,
        metadataJson: {
          employee_id: employee.id
        }
      });

      return {
        employee,
        onboardingIntake
      };
    });
  }

  async createGoogleWorkspaceAccessRequestForOnboarding(input: {
    onboardingIntake: OnboardingIntake;
    employee: Employee;
    actorExternalUserId: string;
  }): Promise<{
    onboardingIntake: OnboardingIntake;
    accessRequest: AccessRequest;
  }> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const [system] = await tx
        .select()
        .from(systems)
        .where(eq(systems.key, SYSTEM_KEY.googleWorkspace))
        .limit(1);

      const [resource] = system
        ? await tx
            .select()
            .from(accessResources)
            .where(and(eq(accessResources.systemId, system.id), eq(accessResources.key, ACCESS_RESOURCE_KEY.companyEmail)))
            .limit(1)
        : [];

      const [role] = system
        ? await tx
            .select()
            .from(roles)
            .where(and(eq(roles.systemId, system.id), eq(roles.key, ROLE_KEY.user)))
            .limit(1)
        : [];

      if (!system || !resource || !role) {
        throw new Error("Google Workspace company email access catalog is not configured.");
      }

      const [accessRequest] = await tx
        .insert(accessRequests)
        .values({
          employeeId: input.employee.id,
          systemId: system.id,
          resourceId: resource.id,
          roleId: role.id,
          action: ACCESS_REQUEST_ACTION.grant,
          status: ACCESS_REQUEST_STATUS.waitingForApproval,
          reason: "Company email required for onboarding",
          requestedByExternalUserId: input.actorExternalUserId,
          requestedFrom: "onboarding_intake"
        })
        .returning();

      const [onboardingIntake] = await tx
        .update(onboardingIntakes)
        .set({
          googleWorkspaceAccessRequestId: accessRequest.id,
          status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
          updatedAt: new Date()
        })
        .where(eq(onboardingIntakes.id, input.onboardingIntake.id))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "onboarding.google_workspace_email_requested",
        entityType: "onboarding_intake",
        entityId: onboardingIntake.id,
        afterJson: onboardingIntake,
        metadataJson: {
          employee_id: input.employee.id,
          access_request_id: accessRequest.id
        }
      });

      return {
        onboardingIntake,
        accessRequest
      };
    });
  }

  private async createEmployeeForOnboardingInTransaction(
    tx: Transaction,
    input: {
      onboardingIntake: OnboardingIntake;
    }
  ): Promise<Employee> {
    const [employee] = await tx
      .insert(employees)
      .values({
        fullName: requireIntakeValue(input.onboardingIntake.name, "name"),
        personalEmail: requireIntakeValue(input.onboardingIntake.personalEmail, "personalEmail"),
        workEmail: null,
        contactNo: input.onboardingIntake.contactNo,
        employmentType: requireEmploymentType(input.onboardingIntake.employmentType),
        designation: requireIntakeValue(input.onboardingIntake.designation, "designation"),
        status: EMPLOYEE_STATUS.preboarding,
        startDate: requireIntakeValue(input.onboardingIntake.doj, "doj")
      })
      .returning();

    return employee;
  }

  private async updateOnboardingIntakeAfterEmployeeCreation(
    tx: Transaction,
    input: {
      onboardingIntakeId: string;
      employee: Employee;
      actorExternalUserId: string;
    }
  ): Promise<OnboardingIntake> {
    const [onboardingIntake] = await tx
      .update(onboardingIntakes)
      .set({
        employeeId: input.employee.id,
        status: ONBOARDING_INTAKE_STATUS.approved,
        updatedAt: new Date()
      })
      .where(eq(onboardingIntakes.id, input.onboardingIntakeId))
      .returning();

    await tx.insert(auditEvents).values({
      actorExternalUserId: input.actorExternalUserId,
      eventType: "onboarding.employee_created",
      entityType: "onboarding_intake",
      entityId: onboardingIntake.id,
      afterJson: onboardingIntake,
      metadataJson: {
        employee_id: input.employee.id
      }
    });

    return onboardingIntake;
  }

  private async createGoogleWorkspaceAccessRequestForOnboardingInTransaction(
    tx: Transaction,
    input: {
      employee: Employee;
      requestedByExternalUserId: string;
    }
  ): Promise<AccessRequest> {
    const catalog = await this.findGoogleWorkspaceCompanyEmailCatalogInTransaction(tx);

    const [accessRequest] = await tx
      .insert(accessRequests)
      .values({
        employeeId: input.employee.id,
        systemId: catalog.system.id,
        resourceId: catalog.resource.id,
        roleId: catalog.role.id,
        action: ACCESS_REQUEST_ACTION.grant,
        status: ACCESS_REQUEST_STATUS.waitingForApproval,
        reason: "Company email required for onboarding",
        requestedByExternalUserId: input.requestedByExternalUserId,
        requestedFrom: "onboarding_intake"
      })
      .returning();

    return accessRequest;
  }

  private async createOrFindAccessRequestApprovalInTransaction(
    tx: Transaction,
    input: {
      accessRequest: AccessRequest;
      input: DecideOnboardingIntakeRepositoryInput;
    }
  ): Promise<Approval> {
    const [existingApproval] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.accessRequestId, input.accessRequest.id), eq(approvals.decision, APPROVAL_DECISION.approved)))
      .limit(1);

    if (existingApproval) {
      return existingApproval;
    }

    const [approval] = await tx
      .insert(approvals)
      .values({
        accessRequestId: input.accessRequest.id,
        approverExternalUserId: input.input.approverExternalUserId,
        decision: APPROVAL_DECISION.approved,
        comment: input.input.comment ?? "Approved as part of onboarding intake approval",
        source: "onboarding_intake",
        gantryConversationId: input.input.gantryConversationId ?? null,
        gantryRuntimeEventId: input.input.gantryRuntimeEventId ?? null
      })
      .returning();

    await tx.insert(auditEvents).values({
      actorExternalUserId: input.input.approverExternalUserId,
      eventType: "approval.approved",
      entityType: "approval",
      entityId: approval.id,
      afterJson: approval,
      metadataJson: {
        access_request_id: input.accessRequest.id,
        onboarding_intake_id: input.input.onboardingIntake.id
      }
    });

    return approval;
  }

  private async approveAccessRequestInTransaction(
    tx: Transaction,
    input: {
      accessRequest: AccessRequest;
    }
  ): Promise<AccessRequest> {
    if (input.accessRequest.status === ACCESS_REQUEST_STATUS.approved) {
      return input.accessRequest;
    }

    const [accessRequest] = await tx
      .update(accessRequests)
      .set({
        status: ACCESS_REQUEST_STATUS.approved,
        updatedAt: new Date()
      })
      .where(eq(accessRequests.id, input.accessRequest.id))
      .returning();

    return accessRequest;
  }

  private async createOrFindAccessTaskInTransaction(
    tx: Transaction,
    input: {
      accessRequest: AccessRequest;
      actorExternalUserId: string;
    }
  ): Promise<AccessTask> {
    const taskContext = await this.findAccessTaskContextInTransaction(tx, input.accessRequest.id);
    const idempotencyKey = [
      input.accessRequest.action,
      input.accessRequest.employeeId,
      taskContext.systemKey,
      taskContext.resourceKey,
      taskContext.roleKey
    ].join(":");

    const initialStatus = getInitialOnboardingAccessTaskStatus(taskContext, this.slackWorkspaceInviteMode);

    const [createdTask] = await tx
      .insert(accessTasks)
      .values({
        accessRequestId: input.accessRequest.id,
        operation: input.accessRequest.action,
        connector: taskContext.systemKey,
        status: initialStatus,
        idempotencyKey
      })
      .onConflictDoNothing({ target: accessTasks.idempotencyKey })
      .returning();

    if (createdTask) {
      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "access_task.created",
        entityType: "access_task",
        entityId: createdTask.id,
        afterJson: createdTask,
        metadataJson: {
          access_request_id: input.accessRequest.id
        }
      });

      return createdTask;
    }

    const [existingTask] = await tx
      .select()
      .from(accessTasks)
      .where(eq(accessTasks.idempotencyKey, idempotencyKey))
      .limit(1);

    if (!existingTask) {
      throw new Error("Access task idempotency lookup failed.");
    }

    return existingTask;
  }

  private async updateOnboardingIntakeReadyForProvisioning(
    tx: Transaction,
    input: {
      onboardingIntakeId: string;
      accessRequest: AccessRequest;
    }
  ): Promise<OnboardingIntake> {
    const [onboardingIntake] = await tx
      .update(onboardingIntakes)
      .set({
        googleWorkspaceAccessRequestId: input.accessRequest.id,
        status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
        updatedAt: new Date()
      })
      .where(eq(onboardingIntakes.id, input.onboardingIntakeId))
      .returning();

    await tx.insert(auditEvents).values({
      actorExternalUserId: input.accessRequest.requestedByExternalUserId,
      eventType: "onboarding.google_workspace_email_request_created",
      entityType: "onboarding_intake",
      entityId: onboardingIntake.id,
      afterJson: onboardingIntake,
      metadataJson: {
        employee_id: input.accessRequest.employeeId,
        access_request_id: input.accessRequest.id
      }
    });

    return onboardingIntake;
  }

  private async findGoogleWorkspaceCompanyEmailCatalogInTransaction(
    tx: Transaction
  ): Promise<{
    system: typeof systems.$inferSelect;
    resource: typeof accessResources.$inferSelect;
    role: typeof roles.$inferSelect;
  }> {
    const [system] = await tx.select().from(systems).where(eq(systems.key, SYSTEM_KEY.googleWorkspace)).limit(1);

    const [resource] = system
      ? await tx
          .select()
          .from(accessResources)
          .where(and(eq(accessResources.systemId, system.id), eq(accessResources.key, ACCESS_RESOURCE_KEY.companyEmail)))
          .limit(1)
      : [];

    const [role] = system
      ? await tx
          .select()
          .from(roles)
          .where(and(eq(roles.systemId, system.id), eq(roles.key, ROLE_KEY.user)))
          .limit(1)
      : [];

    if (!system || !resource || !role) {
      throw new Error("Google Workspace company email access catalog is not configured.");
    }

    return { system, resource, role };
  }

  private async findAccessTaskContextInTransaction(
    tx: Transaction,
    accessRequestId: string
  ): Promise<{
    systemKey: string;
    resourceKey: string;
    resourceType: string;
    roleKey: string;
  }> {
    const [taskContext] = await tx
      .select({
        systemKey: systems.key,
        resourceKey: accessResources.key,
        resourceType: accessResources.resourceType,
        roleKey: roles.key
      })
      .from(accessRequests)
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessRequests.roleId, roles.id))
      .where(eq(accessRequests.id, accessRequestId))
      .limit(1);

    if (!taskContext) {
      throw new Error("Access request task context was not found.");
    }

    return taskContext;
  }

  private async createOrFindSlackChannelAccessForOnboardingInTransaction(
    tx: Transaction,
    input: {
      onboardingIntake: OnboardingIntake;
      employee: Employee;
      input: DecideOnboardingIntakeRepositoryInput;
    }
  ): Promise<{
    accessRequests: AccessRequest[];
    accessTasks: AccessTask[];
  }> {
    const channelKeys = normalizeSlackChannelNames(input.onboardingIntake.requestedSlackChannels);

    if (channelKeys.length === 0) {
      return {
        accessRequests: [],
        accessTasks: []
      };
    }

    const slackCatalog = await this.findSlackMemberCatalogInTransaction(tx);
    const requestedByExternalUserId = requireIntakeValue(
      input.input.sourceMessage.senderExternalUserId,
      "sourceMessage.senderExternalUserId"
    );
    const slackAccessRequests: AccessRequest[] = [];
    const slackAccessTasks: AccessTask[] = [];

    for (const channelKey of channelKeys) {
      // Onboarding approval creates approved access requests/tasks only.
      // Channel grants become active later, after workspace membership and task execution.
      const resource = await this.findOrCreateSlackChannelResourceInTransaction(tx, channelKey);
      const accessRequest = await this.createOrFindSlackChannelAccessRequestInTransaction(tx, {
        employeeId: input.employee.id,
        systemId: slackCatalog.system.id,
        resourceId: resource.id,
        roleId: slackCatalog.role.id,
        channelKey,
        requestedByExternalUserId,
        approverExternalUserId: input.input.approverExternalUserId,
        onboardingIntakeId: input.onboardingIntake.id
      });

      await this.createOrFindAccessRequestApprovalInTransaction(tx, {
        accessRequest,
        input: input.input
      });

      const approvedAccessRequest = await this.approveAccessRequestInTransaction(tx, {
        accessRequest
      });
      const accessTask = await this.createOrFindAccessTaskInTransaction(tx, {
        accessRequest: approvedAccessRequest,
        actorExternalUserId: input.input.approverExternalUserId
      });

      slackAccessRequests.push(approvedAccessRequest);
      slackAccessTasks.push(accessTask);
    }

    return {
      accessRequests: slackAccessRequests,
      accessTasks: slackAccessTasks
    };
  }

  private async createOrFindSlackWorkspaceMembershipAccessForOnboardingInTransaction(
    tx: Transaction,
    input: {
      onboardingIntake: OnboardingIntake;
      employee: Employee;
      input: DecideOnboardingIntakeRepositoryInput;
    }
  ): Promise<{
    accessRequest: AccessRequest | null;
    accessTask: AccessTask | null;
  }> {
    // Slack workspace membership is a standard onboarding requirement. Channel requests
    // are optional follow-up context, but they do not control whether the invite is sent.
    const slackCatalog = await this.findSlackWorkspaceMembershipCatalogInTransaction(tx);
    const requestedByExternalUserId = requireIntakeValue(
      input.input.sourceMessage.senderExternalUserId,
      "sourceMessage.senderExternalUserId"
    );
    const accessRequest = await this.createOrFindSlackWorkspaceMembershipAccessRequestInTransaction(tx, {
      employeeId: input.employee.id,
      systemId: slackCatalog.system.id,
      resourceId: slackCatalog.resource.id,
      roleId: slackCatalog.role.id,
      requestedByExternalUserId,
      approverExternalUserId: input.input.approverExternalUserId,
      onboardingIntakeId: input.onboardingIntake.id
    });

    await this.createOrFindAccessRequestApprovalInTransaction(tx, {
      accessRequest,
      input: input.input
    });

    const approvedAccessRequest = await this.approveAccessRequestInTransaction(tx, {
      accessRequest
    });
    const accessTask = await this.createOrFindAccessTaskInTransaction(tx, {
      accessRequest: approvedAccessRequest,
      actorExternalUserId: input.input.approverExternalUserId
    });

    return {
      accessRequest: approvedAccessRequest,
      accessTask
    };
  }

  private async createOrFindSlackWorkspaceMembershipAccessRequestInTransaction(
    tx: Transaction,
    input: {
      employeeId: string;
      systemId: string;
      resourceId: string;
      roleId: string;
      requestedByExternalUserId: string;
      approverExternalUserId: string;
      onboardingIntakeId: string;
    }
  ): Promise<AccessRequest> {
    const [existingAccessRequest] = await tx
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.employeeId, input.employeeId),
          eq(accessRequests.systemId, input.systemId),
          eq(accessRequests.resourceId, input.resourceId),
          eq(accessRequests.roleId, input.roleId),
          eq(accessRequests.action, ACCESS_REQUEST_ACTION.grant),
          inArray(accessRequests.status, [
            ACCESS_REQUEST_STATUS.draft,
            ACCESS_REQUEST_STATUS.waitingForApproval,
            ACCESS_REQUEST_STATUS.approved,
            ACCESS_REQUEST_STATUS.provisioning,
            ACCESS_REQUEST_STATUS.completed
          ])
        )
      )
      .limit(1);

    if (existingAccessRequest) {
      return existingAccessRequest;
    }

    const [accessRequest] = await tx
      .insert(accessRequests)
      .values({
        employeeId: input.employeeId,
        systemId: input.systemId,
        resourceId: input.resourceId,
        roleId: input.roleId,
        action: ACCESS_REQUEST_ACTION.grant,
        status: ACCESS_REQUEST_STATUS.waitingForApproval,
        reason: "Slack workspace membership required for onboarding",
        requestedByExternalUserId: input.requestedByExternalUserId,
        requestedFrom: "onboarding_intake"
      })
      .returning();

    await tx.insert(auditEvents).values({
      actorExternalUserId: input.approverExternalUserId,
      eventType: "onboarding.slack_workspace_membership_requested",
      entityType: "onboarding_intake",
      entityId: input.onboardingIntakeId,
      afterJson: accessRequest,
      metadataJson: {
        employee_id: input.employeeId,
        access_request_id: accessRequest.id
      }
    });

    return accessRequest;
  }

  private async createOrFindSlackChannelAccessRequestInTransaction(
    tx: Transaction,
    input: {
      employeeId: string;
      systemId: string;
      resourceId: string;
      roleId: string;
      channelKey: string;
      requestedByExternalUserId: string;
      approverExternalUserId: string;
      onboardingIntakeId: string;
    }
  ): Promise<AccessRequest> {
    const [existingAccessRequest] = await tx
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.employeeId, input.employeeId),
          eq(accessRequests.systemId, input.systemId),
          eq(accessRequests.resourceId, input.resourceId),
          eq(accessRequests.roleId, input.roleId),
          eq(accessRequests.action, ACCESS_REQUEST_ACTION.grant),
          inArray(accessRequests.status, [
            ACCESS_REQUEST_STATUS.draft,
            ACCESS_REQUEST_STATUS.waitingForApproval,
            ACCESS_REQUEST_STATUS.approved,
            ACCESS_REQUEST_STATUS.provisioning,
            ACCESS_REQUEST_STATUS.completed
          ])
        )
      )
      .limit(1);

    if (existingAccessRequest) {
      return existingAccessRequest;
    }

    const [accessRequest] = await tx
      .insert(accessRequests)
      .values({
        employeeId: input.employeeId,
        systemId: input.systemId,
        resourceId: input.resourceId,
        roleId: input.roleId,
        action: ACCESS_REQUEST_ACTION.grant,
        status: ACCESS_REQUEST_STATUS.waitingForApproval,
        reason: "Slack channel access requested during onboarding",
        requestedByExternalUserId: input.requestedByExternalUserId,
        requestedFrom: "onboarding_intake"
      })
      .returning();

    await tx.insert(auditEvents).values({
      actorExternalUserId: input.approverExternalUserId,
      eventType: "onboarding.slack_channel_access_requested",
      entityType: "onboarding_intake",
      entityId: input.onboardingIntakeId,
      afterJson: accessRequest,
      metadataJson: {
        employee_id: input.employeeId,
        access_request_id: accessRequest.id,
        slack_channel: input.channelKey
      }
    });

    return accessRequest;
  }

  private async findOrCreateSlackChannelResourceInTransaction(
    tx: Transaction,
    channelName: string
  ): Promise<AccessResource> {
    const channelKey = normalizeSlackChannelName(channelName);

    if (!channelKey) {
      throw new Error("Slack channel name is required.");
    }

    const slackCatalog = await this.findSlackMemberCatalogInTransaction(tx);
    const [resource] = await tx
      .insert(accessResources)
      .values({
        systemId: slackCatalog.system.id,
        key: channelKey,
        name: `#${channelKey}`,
        resourceType: ACCESS_RESOURCE_TYPE.channel
      })
      .onConflictDoUpdate({
        target: [accessResources.systemId, accessResources.key],
        set: {
          name: `#${channelKey}`,
          resourceType: ACCESS_RESOURCE_TYPE.channel,
          updatedAt: new Date()
        }
      })
      .returning();

    return resource;
  }

  private async findSlackMemberCatalogInTransaction(tx: Transaction): Promise<{
    system: typeof systems.$inferSelect;
    role: typeof roles.$inferSelect;
  }> {
    const [system] = await tx.select().from(systems).where(eq(systems.key, SYSTEM_KEY.slack)).limit(1);

    const [role] = system
      ? await tx
          .select()
          .from(roles)
          .where(and(eq(roles.systemId, system.id), eq(roles.key, ROLE_KEY.member)))
          .limit(1)
      : [];

    if (!system || !role) {
      throw new Error("Slack channel access catalog is not configured. Run pnpm seed:slack.");
    }

    return { system, role };
  }

  private async findSlackWorkspaceMembershipCatalog(): Promise<{
    system: typeof systems.$inferSelect;
    resource: typeof accessResources.$inferSelect;
    role: typeof roles.$inferSelect;
  }> {
    const [system] = await this.databaseProvider.db
      .select()
      .from(systems)
      .where(eq(systems.key, SYSTEM_KEY.slack))
      .limit(1);

    const [resource] = system
      ? await this.databaseProvider.db
          .select()
          .from(accessResources)
          .where(and(eq(accessResources.systemId, system.id), eq(accessResources.key, ACCESS_RESOURCE_KEY.workspaceMembership)))
          .limit(1)
      : [];

    const [role] = system
      ? await this.databaseProvider.db
          .select()
          .from(roles)
          .where(and(eq(roles.systemId, system.id), eq(roles.key, ROLE_KEY.member)))
          .limit(1)
      : [];

    if (!system || !resource || !role) {
      throw new Error("Slack workspace membership access catalog is not configured. Run pnpm seed:slack.");
    }

    return { system, resource, role };
  }

  private async findSlackWorkspaceMembershipCatalogInTransaction(tx: Transaction): Promise<{
    system: typeof systems.$inferSelect;
    resource: typeof accessResources.$inferSelect;
    role: typeof roles.$inferSelect;
  }> {
    const [system] = await tx.select().from(systems).where(eq(systems.key, SYSTEM_KEY.slack)).limit(1);

    const [resource] = system
      ? await tx
          .select()
          .from(accessResources)
          .where(and(eq(accessResources.systemId, system.id), eq(accessResources.key, ACCESS_RESOURCE_KEY.workspaceMembership)))
          .limit(1)
      : [];

    const [role] = system
      ? await tx
          .select()
          .from(roles)
          .where(and(eq(roles.systemId, system.id), eq(roles.key, ROLE_KEY.member)))
          .limit(1)
      : [];

    if (!system || !resource || !role) {
      throw new Error("Slack workspace membership access catalog is not configured. Run pnpm seed:slack.");
    }

    return { system, resource, role };
  }

  private async findSlackMemberCatalog(): Promise<{
    system: typeof systems.$inferSelect;
    role: typeof roles.$inferSelect;
  }> {
    const [system] = await this.databaseProvider.db
      .select()
      .from(systems)
      .where(eq(systems.key, SYSTEM_KEY.slack))
      .limit(1);

    const [role] = system
      ? await this.databaseProvider.db
          .select()
          .from(roles)
          .where(and(eq(roles.systemId, system.id), eq(roles.key, ROLE_KEY.member)))
          .limit(1)
      : [];

    if (!system || !role) {
      throw new Error("Slack channel access catalog is not configured. Run pnpm seed:slack.");
    }

    return { system, role };
  }

  private async findSlackChannelResourceByKey(
    systemId: string,
    channelKey: string
  ): Promise<AccessResource | undefined> {
    const [resource] = await this.databaseProvider.db
      .select()
      .from(accessResources)
      .where(and(eq(accessResources.systemId, systemId), eq(accessResources.key, channelKey)))
      .limit(1);

    return resource;
  }

  private async findSlackChannelAccessRequest(input: {
    employeeId: string;
    systemId: string;
    resourceId: string;
    roleId: string;
  }): Promise<AccessRequest | undefined> {
    const [accessRequest] = await this.databaseProvider.db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.employeeId, input.employeeId),
          eq(accessRequests.systemId, input.systemId),
          eq(accessRequests.resourceId, input.resourceId),
          eq(accessRequests.roleId, input.roleId),
          eq(accessRequests.action, ACCESS_REQUEST_ACTION.grant),
          inArray(accessRequests.status, [
            ACCESS_REQUEST_STATUS.draft,
            ACCESS_REQUEST_STATUS.waitingForApproval,
            ACCESS_REQUEST_STATUS.approved,
            ACCESS_REQUEST_STATUS.provisioning,
            ACCESS_REQUEST_STATUS.completed
          ])
        )
      )
      .limit(1);

    return accessRequest;
  }

  private async findSlackWorkspaceMembershipAccessRequest(input: {
    employeeId: string;
    systemId: string;
    resourceId: string;
    roleId: string;
  }): Promise<AccessRequest | undefined> {
    const [accessRequest] = await this.databaseProvider.db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.employeeId, input.employeeId),
          eq(accessRequests.systemId, input.systemId),
          eq(accessRequests.resourceId, input.resourceId),
          eq(accessRequests.roleId, input.roleId),
          eq(accessRequests.action, ACCESS_REQUEST_ACTION.grant),
          inArray(accessRequests.status, [
            ACCESS_REQUEST_STATUS.draft,
            ACCESS_REQUEST_STATUS.waitingForApproval,
            ACCESS_REQUEST_STATUS.approved,
            ACCESS_REQUEST_STATUS.provisioning,
            ACCESS_REQUEST_STATUS.completed
          ])
        )
      )
      .limit(1);

    return accessRequest;
  }

  async findSlackSourceMessageByNaturalKey(input: {
    workspaceId: string;
    channelId: string;
    messageTs: string;
  }): Promise<SlackSourceMessage | undefined> {
    const [sourceMessage] = await this.databaseProvider.db
      .select()
      .from(slackSourceMessages)
      .where(
        and(
          eq(slackSourceMessages.provider, "slack"),
          eq(slackSourceMessages.workspaceId, input.workspaceId),
          eq(slackSourceMessages.channelId, input.channelId),
          eq(slackSourceMessages.messageTs, input.messageTs)
        )
      )
      .limit(1);

    return sourceMessage;
  }
}

export function getRequiredOnboardingSetupCompleteness(
  onboardingIntake: OnboardingIntake,
  setupItems: OnboardingSetupItem[]
): {
  requiredItems: OnboardingSetupItem[];
  missingRequiredCount: number;
} {
  const requiredTargets: Array<{
    systemKey: string;
    resourceKey: string;
    resourceType: string;
  }> = [
    {
      systemKey: SYSTEM_KEY.googleWorkspace,
      resourceKey: ACCESS_RESOURCE_KEY.companyEmail,
      resourceType: ACCESS_RESOURCE_TYPE.account
    },
    {
      systemKey: SYSTEM_KEY.slack,
      resourceKey: ACCESS_RESOURCE_KEY.workspaceMembership,
      resourceType: ACCESS_RESOURCE_TYPE.workspace
    }
  ];

  const requiredItems = setupItems.filter((item) =>
    requiredTargets.some((target) =>
      item.system.key === target.systemKey &&
      item.resource.key === target.resourceKey &&
      item.resource.resourceType === target.resourceType
    )
  );
  const missingRequiredCount = requiredTargets.filter((target) =>
    !setupItems.some((item) =>
      item.system.key === target.systemKey &&
      item.resource.key === target.resourceKey &&
      item.resource.resourceType === target.resourceType
    )
  ).length;

  return {
    requiredItems,
    missingRequiredCount
  };
}

function summarizeOnboardingSetupItems(
  setupItems: OnboardingSetupItem[],
  missingRequiredCount: number
): OnboardingStatusSummary {
  const completed = setupItems.filter(isCompletedOnboardingSetupItem).length;
  const failed = setupItems.filter((item) =>
    item.taskStatus === ACCESS_TASK_STATUS.failed ||
    item.requestStatus === ACCESS_REQUEST_STATUS.failed ||
    item.grantStatus === ACCESS_GRANT_STATUS.failed
  ).length;

  return {
    total: setupItems.length + missingRequiredCount,
    completed,
    pending: setupItems.length + missingRequiredCount - completed - failed,
    failed
  };
}

function isCompletedOnboardingSetupItem(item: OnboardingSetupItem): boolean {
  return item.taskStatus === ACCESS_TASK_STATUS.completed && item.grantStatus === ACCESS_GRANT_STATUS.active;
}

function requireIntakeValue(value: string | null, fieldName: string): string {
  if (!value) {
    throw new Error(`Valid onboarding intake is missing ${fieldName}.`);
  }

  return value;
}

export function getInitialOnboardingAccessTaskStatus(
  taskContext: {
    systemKey: string;
    resourceKey: string;
    resourceType: string;
  },
  slackWorkspaceInviteMode: SlackWorkspaceInviteMode
): (typeof ACCESS_TASK_STATUS)[keyof typeof ACCESS_TASK_STATUS] {
  if (taskContext.systemKey === SYSTEM_KEY.googleWorkspace) {
    return ACCESS_TASK_STATUS.pending;
  }

  if (taskContext.systemKey === SYSTEM_KEY.slack && taskContext.resourceKey === ACCESS_RESOURCE_KEY.workspaceMembership) {
    return slackWorkspaceInviteMode === "browser" || slackWorkspaceInviteMode === "automated"
      ? ACCESS_TASK_STATUS.pending
      : ACCESS_TASK_STATUS.pendingManual;
  }

  if (taskContext.systemKey === SYSTEM_KEY.slack && taskContext.resourceType === ACCESS_RESOURCE_TYPE.channel) {
    return ACCESS_TASK_STATUS.pendingDependency;
  }

  return ACCESS_TASK_STATUS.pendingManual;
}

function requireEmploymentType(value: string | null): "fte" | "contractor" {
  if (value === "fte" || value === "contractor") {
    return value;
  }

  throw new Error("Valid onboarding intake is missing employmentType.");
}

function toOnboardingIntakeValues(input: CreateOnboardingIntakeRepositoryInput): typeof onboardingIntakes.$inferInsert {
  const normalized = input.validation.normalized;
  const parsed = input.parsedFields;

  return {
    sourceMessageId: input.sourceMessage.id,
    name: normalized?.name ?? parsed.name,
    personalEmail: normalized?.personalEmail ?? parsed.personalEmail,
    contactNo: normalized?.contactNo ?? parsed.contactNo,
    doj: normalized?.doj ?? parsed.doj,
    employmentType: normalized?.employmentType ?? parsed.employmentType,
    designation: normalized?.designation ?? parsed.designation,
    laptop: normalized?.laptop ?? parsed.laptop,
    relocation: normalized?.relocation ?? parsed.relocation,
    requestedSlackChannels: normalized?.slackChannels ?? parsed.slackChannels,
    validationErrors: input.validation.validationErrors,
    status: input.validation.valid ? ONBOARDING_INTAKE_STATUS.waitingForReview : ONBOARDING_INTAKE_STATUS.validationFailed
  };
}

function normalizeSlackChannelNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .filter((channel): channel is string => typeof channel === "string")
        .map(normalizeSlackChannelName)
        .filter(Boolean)
    )
  ];
}

function normalizeSlackChannelName(value: string): string {
  return value.trim().replace(/^#+/u, "").toLowerCase();
}

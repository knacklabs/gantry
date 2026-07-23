import { Injectable } from "@nestjs/common";
import {
  ACCESS_GRANT_STATUS,
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_STATUS,
  ACCESS_RESOURCE_KEY,
  ACCESS_RESOURCE_TYPE,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_STATUS,
  AUDIT_ACTOR,
  accessGrants,
  accessRequests,
  accessResources,
  accessTasks,
  auditEvents,
  EMPLOYEE_STATUS,
  employees,
  OFFBOARDING_INTAKE_STATUS,
  OFFBOARDING_REVOKE_ITEM_STATUS,
  ONBOARDING_INTAKE_STATUS,
  offboardingIntakes,
  offboardingRevokeItems,
  onboardingIntakes,
  ROLE_KEY,
  roles,
  SYSTEM_KEY,
  systems
} from "@itops/db";
import { and, eq, inArray } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";
import type { MockCompleteAccessTaskInput } from "./dto/mock-complete-access-task.dto.js";

export type AccessTask = typeof accessTasks.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
export type AccessGrant = typeof accessGrants.$inferSelect;
export type Employee = typeof employees.$inferSelect;
export type SystemRecord = typeof systems.$inferSelect;
export type AccessResource = typeof accessResources.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type OffboardingIntake = typeof offboardingIntakes.$inferSelect;

export type MockCompleteAccessTaskResult = {
  task: AccessTask;
  grant: AccessGrant;
};

export type AccessTaskPendingDependencyResult = {
  task: AccessTask;
  grant: null;
  dependencyRequired: true;
  code: string;
};

export type AccessTaskNoGrantResult = {
  task: AccessTask;
  grant: null;
  code: string;
  message: string;
  connectorResult?: Record<string, unknown>;
};

export type ExecuteAccessTaskResult =
  | MockCompleteAccessTaskResult
  | AccessTaskPendingDependencyResult
  | AccessTaskNoGrantResult;

export type AccessTaskExecutionContext = {
  task: AccessTask;
  accessRequest: AccessRequest;
  employee: Employee;
  system: SystemRecord;
  resource: AccessResource;
  role: Role;
};

export type CompleteAccessTaskExecutionInput = {
  context: AccessTaskExecutionContext;
  actorExternalUserId: string;
  primaryEmail: string;
  connectorResult: Record<string, unknown>;
};

export type CompleteConnectorAccessTaskInput = {
  context: AccessTaskExecutionContext;
  actorExternalUserId: string;
  externalAccountId: string | null;
  connectorResult: Record<string, unknown>;
  auditEvents?: Array<{
    eventType: string;
    entityType: string;
    entityId: string;
    afterJson?: Record<string, unknown>;
    metadataJson?: Record<string, unknown>;
  }>;
};

export type CompleteRevokeAccessTaskInput = {
  context: AccessTaskExecutionContext;
  actorExternalUserId: string;
  connectorResult: Record<string, unknown>;
};

export type CompleteSlackChannelRevokeAccessTaskInput = CompleteRevokeAccessTaskInput;

export type CompleteSlackWorkspaceMembershipRevokeAccessTaskInput = CompleteRevokeAccessTaskInput;

export type MarkAccessTaskFailedInput = {
  taskId: string;
  accessRequestId: string;
  actorExternalUserId: string;
  errorMessage: string;
  externalResultJson: Record<string, unknown>;
};

export type MarkAccessTaskPendingDependencyInput = {
  taskId: string;
  accessRequestId: string;
  actorExternalUserId: string;
  errorMessage: string;
  externalResultJson: Record<string, unknown>;
  code: string;
};

type MockCompleteAccessTaskRepositoryInput = MockCompleteAccessTaskInput & {
  context: AccessTaskExecutionContext;
  externalAccountId: string | null;
};

@Injectable()
export class AccessTasksRepository {
  constructor(private readonly databaseProvider: DatabaseProvider) {}

  async findAccessTaskById(id: string): Promise<AccessTask | undefined> {
    const [task] = await this.databaseProvider.db.select().from(accessTasks).where(eq(accessTasks.id, id)).limit(1);
    return task;
  }

  async findExecutionContextByTaskId(id: string): Promise<AccessTaskExecutionContext | undefined> {
    const [row] = await this.databaseProvider.db
      .select({
        task: accessTasks,
        accessRequest: accessRequests,
        employee: employees,
        system: systems,
        resource: accessResources,
        role: roles
      })
      .from(accessTasks)
      .innerJoin(accessRequests, eq(accessTasks.accessRequestId, accessRequests.id))
      .innerJoin(employees, eq(accessRequests.employeeId, employees.id))
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessRequests.roleId, roles.id))
      .where(eq(accessTasks.id, id))
      .limit(1);

    return row;
  }

  async findGrantForAccessRequest(accessRequest: AccessRequest): Promise<AccessGrant | undefined> {
    const [grant] = await this.databaseProvider.db
      .select()
      .from(accessGrants)
      .where(
        and(
          eq(accessGrants.employeeId, accessRequest.employeeId),
          eq(accessGrants.systemId, accessRequest.systemId),
          eq(accessGrants.resourceId, accessRequest.resourceId),
          eq(accessGrants.roleId, accessRequest.roleId)
        )
      )
      .limit(1);

    return grant;
  }

  async isWorkEmailTaken(email: string): Promise<boolean> {
    const [employee] = await this.databaseProvider.db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.workEmail, email))
      .limit(1);

    return Boolean(employee);
  }

  async hasActiveSlackWorkspaceMembershipGrant(employeeId: string): Promise<boolean> {
    const [grant] = await this.databaseProvider.db
      .select({ id: accessGrants.id })
      .from(accessGrants)
      .innerJoin(systems, eq(accessGrants.systemId, systems.id))
      .innerJoin(accessResources, eq(accessGrants.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessGrants.roleId, roles.id))
      .where(
        and(
          eq(accessGrants.employeeId, employeeId),
          eq(accessGrants.status, ACCESS_GRANT_STATUS.active),
          eq(systems.key, SYSTEM_KEY.slack),
          eq(accessResources.key, ACCESS_RESOURCE_KEY.workspaceMembership),
          eq(roles.key, ROLE_KEY.member)
        )
      )
      .limit(1);

    return Boolean(grant);
  }

  async hasRevokedSlackWorkspaceMembershipGrant(employeeId: string): Promise<boolean> {
    const [grant] = await this.databaseProvider.db
      .select({ id: accessGrants.id })
      .from(accessGrants)
      .innerJoin(systems, eq(accessGrants.systemId, systems.id))
      .innerJoin(accessResources, eq(accessGrants.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessGrants.roleId, roles.id))
      .where(
        and(
          eq(accessGrants.employeeId, employeeId),
          eq(accessGrants.status, ACCESS_GRANT_STATUS.revoked),
          eq(systems.key, SYSTEM_KEY.slack),
          eq(accessResources.key, ACCESS_RESOURCE_KEY.workspaceMembership),
          eq(accessResources.resourceType, ACCESS_RESOURCE_TYPE.workspace),
          eq(roles.key, ROLE_KEY.member)
        )
      )
      .limit(1);

    return Boolean(grant);
  }

  async findOffboardingIntakeForAccessTask(taskId: string): Promise<OffboardingIntake | undefined> {
    const [row] = await this.databaseProvider.db
      .select({
        offboardingIntake: offboardingIntakes
      })
      .from(offboardingRevokeItems)
      .innerJoin(offboardingIntakes, eq(offboardingRevokeItems.offboardingIntakeId, offboardingIntakes.id))
      .where(eq(offboardingRevokeItems.accessTaskId, taskId))
      .limit(1);

    return row?.offboardingIntake;
  }

  async finalizeRelatedLifecycleForTerminalAccessTask(input: {
    context: AccessTaskExecutionContext;
  }): Promise<void> {
    await this.finalizeOnboardingForEmployeeIfReady(input.context.employee.id);

    const offboardingIntake = await this.findOffboardingIntakeForAccessTask(input.context.task.id);

    if (offboardingIntake) {
      await this.finalizeOffboardingIfReady({
        offboardingIntake,
        employee: input.context.employee
      });
    }
  }

  private async finalizeOnboardingForEmployeeIfReady(employeeId: string): Promise<void> {
    const candidateIntakes = await this.databaseProvider.db
      .select()
      .from(onboardingIntakes)
      .where(
        and(
          eq(onboardingIntakes.employeeId, employeeId),
          inArray(onboardingIntakes.status, [
            ONBOARDING_INTAKE_STATUS.approved,
            ONBOARDING_INTAKE_STATUS.readyForProvisioning
          ])
        )
      );

    for (const onboardingIntake of candidateIntakes) {
      const requiresSlackWorkspaceMembership =
        Array.isArray(onboardingIntake.requestedSlackChannels) &&
        onboardingIntake.requestedSlackChannels.length > 0;
      const googleWorkspaceReady = await this.hasCompletedOnboardingGrant({
        employeeId,
        systemKey: SYSTEM_KEY.googleWorkspace,
        resourceKey: ACCESS_RESOURCE_KEY.companyEmail,
        resourceType: ACCESS_RESOURCE_TYPE.account
      });
      const slackWorkspaceReady = !requiresSlackWorkspaceMembership || await this.hasCompletedOnboardingGrant({
        employeeId,
        systemKey: SYSTEM_KEY.slack,
        resourceKey: ACCESS_RESOURCE_KEY.workspaceMembership,
        resourceType: ACCESS_RESOURCE_TYPE.workspace
      });

      if (!googleWorkspaceReady || !slackWorkspaceReady) {
        continue;
      }

      await this.databaseProvider.db.transaction(async (tx) => {
        const [currentIntake] = await tx
          .select()
          .from(onboardingIntakes)
          .where(eq(onboardingIntakes.id, onboardingIntake.id))
          .limit(1);

        if (
          !currentIntake ||
          (
            currentIntake.status !== ONBOARDING_INTAKE_STATUS.approved &&
            currentIntake.status !== ONBOARDING_INTAKE_STATUS.readyForProvisioning
          )
        ) {
          return;
        }

        const now = new Date();
        const [finalizedIntake] = await tx
          .update(onboardingIntakes)
          .set({
            status: ONBOARDING_INTAKE_STATUS.completed,
            updatedAt: now
          })
          .where(eq(onboardingIntakes.id, currentIntake.id))
          .returning();

        const [employee] = await tx
          .update(employees)
          .set({
            status: EMPLOYEE_STATUS.active,
            updatedAt: now
          })
          .where(eq(employees.id, employeeId))
          .returning();

        await tx.insert(auditEvents).values([
          {
            actorExternalUserId: "system:onboarding_auto_finalize",
            eventType: "onboarding.completed",
            entityType: "onboarding_intake",
            entityId: finalizedIntake.id,
            afterJson: finalizedIntake,
            metadataJson: {
              employee_id: employee.id,
              auto_finalized: true
            }
          },
          {
            actorExternalUserId: "system:onboarding_auto_finalize",
            eventType: "employee.activated",
            entityType: "employee",
            entityId: employee.id,
            afterJson: employee,
            metadataJson: {
              onboarding_intake_id: finalizedIntake.id,
              auto_finalized: true
            }
          }
        ]);
      });
    }
  }

  private async hasCompletedOnboardingGrant(input: {
    employeeId: string;
    systemKey: string;
    resourceKey: string;
    resourceType: string;
  }): Promise<boolean> {
    const [row] = await this.databaseProvider.db
      .select({ accessTaskId: accessTasks.id })
      .from(accessRequests)
      .innerJoin(accessTasks, eq(accessTasks.accessRequestId, accessRequests.id))
      .innerJoin(accessGrants, and(
        eq(accessGrants.employeeId, accessRequests.employeeId),
        eq(accessGrants.systemId, accessRequests.systemId),
        eq(accessGrants.resourceId, accessRequests.resourceId),
        eq(accessGrants.roleId, accessRequests.roleId)
      ))
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .where(
        and(
          eq(accessRequests.employeeId, input.employeeId),
          eq(accessRequests.action, ACCESS_REQUEST_ACTION.grant),
          eq(accessRequests.requestedFrom, "onboarding_intake"),
          eq(accessTasks.status, ACCESS_TASK_STATUS.completed),
          eq(accessGrants.status, ACCESS_GRANT_STATUS.active),
          eq(systems.key, input.systemKey),
          eq(accessResources.key, input.resourceKey),
          eq(accessResources.resourceType, input.resourceType)
        )
      )
      .limit(1);

    return Boolean(row);
  }

  private async finalizeOffboardingIfReady(input: {
    offboardingIntake: OffboardingIntake;
    employee: Employee;
  }): Promise<void> {
    if (
      input.offboardingIntake.status !== OFFBOARDING_INTAKE_STATUS.approved &&
      input.offboardingIntake.status !== OFFBOARDING_INTAKE_STATUS.inProgress
    ) {
      return;
    }

    await this.databaseProvider.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          revokeItem: offboardingRevokeItems,
          task: accessTasks
        })
        .from(offboardingRevokeItems)
        .innerJoin(accessTasks, eq(offboardingRevokeItems.accessTaskId, accessTasks.id))
        .where(eq(offboardingRevokeItems.offboardingIntakeId, input.offboardingIntake.id));

      if (rows.length === 0 || !rows.every((row) => isTerminalSuccessfulOffboardingTask(row.task))) {
        return;
      }

      const [currentIntake] = await tx
        .select()
        .from(offboardingIntakes)
        .where(eq(offboardingIntakes.id, input.offboardingIntake.id))
        .limit(1);

      if (
        !currentIntake ||
        (
          currentIntake.status !== OFFBOARDING_INTAKE_STATUS.approved &&
          currentIntake.status !== OFFBOARDING_INTAKE_STATUS.inProgress
        )
      ) {
        return;
      }

      const now = new Date();
      const [offboardingIntake] = await tx
        .update(offboardingIntakes)
        .set({
          status: OFFBOARDING_INTAKE_STATUS.completed,
          completedAt: now,
          updatedAt: now
        })
        .where(eq(offboardingIntakes.id, currentIntake.id))
        .returning();

      const [employee] = await tx
        .update(employees)
        .set({
          status: EMPLOYEE_STATUS.offboarded,
          endDate: input.employee.endDate ?? currentIntake.lastWorkingDay ?? null,
          updatedAt: now
        })
        .where(eq(employees.id, input.employee.id))
        .returning();

      await tx
        .update(offboardingRevokeItems)
        .set({
          status: OFFBOARDING_REVOKE_ITEM_STATUS.completed,
          completedAt: now,
          updatedAt: now
        })
        .where(eq(offboardingRevokeItems.offboardingIntakeId, offboardingIntake.id));

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: AUDIT_ACTOR.system,
          eventType: "offboarding.completed",
          entityType: "offboarding_intake",
          entityId: offboardingIntake.id,
          afterJson: offboardingIntake,
          metadataJson: {
            employee_id: employee.id,
            revoke_item_count: rows.length,
            auto_finalized: true
          }
        },
        {
          actorExternalUserId: AUDIT_ACTOR.system,
          eventType: "employee.offboarded",
          entityType: "employee",
          entityId: employee.id,
          beforeJson: {
            status: input.employee.status,
            endDate: input.employee.endDate
          },
          afterJson: {
            status: employee.status,
            endDate: employee.endDate
          },
          metadataJson: {
            offboarding_intake_id: offboardingIntake.id,
            auto_finalized: true
          }
        }
      ]);
    });
  }

  async recordOffboardingTransitionDenied(input: {
    offboardingIntake: OffboardingIntake;
    actorExternalUserId: string;
    attemptedAction: string;
    currentState: string;
    reason: string;
    accessTaskId: string;
  }): Promise<void> {
    await this.databaseProvider.db.insert(auditEvents).values({
      actorExternalUserId: input.actorExternalUserId,
      eventType: "offboarding.transition_denied",
      entityType: "offboarding_intake",
      entityId: input.offboardingIntake.id,
      metadataJson: {
        attempted_action: input.attemptedAction,
        current_state: input.currentState,
        reason: input.reason,
        employee_id: input.offboardingIntake.employeeId,
        access_task_id: input.accessTaskId
      }
    });
  }

  async markAccessTaskRunning(input: {
    taskId: string;
    accessRequestId: string;
    actorExternalUserId: string;
  }): Promise<AccessTask> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.running,
          errorMessage: null,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.taskId))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "access_task.running",
        entityType: "access_task",
        entityId: task.id,
        afterJson: task,
        metadataJson: {
          access_request_id: input.accessRequestId
        }
      });

      return task;
    });
  }

  async markAccessTaskFailed(input: MarkAccessTaskFailedInput): Promise<AccessTask> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.failed,
          errorMessage: input.errorMessage,
          externalResultJson: input.externalResultJson,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.taskId))
        .returning();

      await tx
        .update(accessRequests)
        .set({
          status: ACCESS_REQUEST_STATUS.failed,
          updatedAt: now
        })
        .where(eq(accessRequests.id, input.accessRequestId));

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "access_task.failed",
        entityType: "access_task",
        entityId: task.id,
        afterJson: task,
        metadataJson: {
          access_request_id: input.accessRequestId
        }
      });

      return task;
    });
  }

  async markAccessTaskPendingDependency(
    input: MarkAccessTaskPendingDependencyInput
  ): Promise<AccessTaskPendingDependencyResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.pendingDependency,
          errorMessage: input.errorMessage,
          externalResultJson: input.externalResultJson,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.taskId))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "access_task.pending_dependency",
        entityType: "access_task",
        entityId: task.id,
        afterJson: task,
        metadataJson: {
          access_request_id: input.accessRequestId
        }
      });

      return {
        task,
        grant: null,
        dependencyRequired: true,
        code: input.code
      };
    });
  }

  async markAccessTaskRetrying(input: MarkAccessTaskFailedInput): Promise<AccessTask> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.retrying,
          errorMessage: input.errorMessage,
          externalResultJson: input.externalResultJson,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.taskId))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.actorExternalUserId,
        eventType: "access_task.retrying",
        entityType: "access_task",
        entityId: task.id,
        afterJson: task,
        metadataJson: {
          access_request_id: input.accessRequestId
        }
      });

      return task;
    });
  }

  async completeExecutedAccessTask(input: CompleteAccessTaskExecutionInput): Promise<MockCompleteAccessTaskResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const previousWorkEmail = input.context.employee.workEmail;

      let updatedEmployee: Employee | undefined;

      if (previousWorkEmail !== input.primaryEmail) {
        const [employee] = await tx
          .update(employees)
          .set({
            workEmail: input.primaryEmail,
            updatedAt: now
          })
          .where(eq(employees.id, input.context.employee.id))
          .returning();

        updatedEmployee = employee;
      }

      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.completed,
          errorMessage: null,
          externalResultJson: input.connectorResult,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.context.task.id))
        .returning();

      const [grant] = await tx
        .insert(accessGrants)
        .values({
          employeeId: input.context.accessRequest.employeeId,
          systemId: input.context.accessRequest.systemId,
          resourceId: input.context.accessRequest.resourceId,
          roleId: input.context.accessRequest.roleId,
          status: ACCESS_GRANT_STATUS.active,
          externalAccountId: input.primaryEmail,
          grantedAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [
            accessGrants.employeeId,
            accessGrants.systemId,
            accessGrants.resourceId,
            accessGrants.roleId
          ],
          set: {
            status: ACCESS_GRANT_STATUS.active,
            externalAccountId: input.primaryEmail,
            grantedAt: now,
            revokedAt: null,
            updatedAt: now
          }
        })
        .returning();

      await tx
        .update(accessRequests)
        .set({
          status: ACCESS_REQUEST_STATUS.completed,
          updatedAt: now
        })
        .where(eq(accessRequests.id, input.context.accessRequest.id));

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_task.completed",
          entityType: "access_task",
          entityId: task.id,
          afterJson: task,
          metadataJson: {
            access_request_id: input.context.accessRequest.id
          }
        },
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_grant.activated",
          entityType: "access_grant",
          entityId: grant.id,
          afterJson: grant,
          metadataJson: {
            access_request_id: input.context.accessRequest.id,
            access_task_id: task.id
          }
        }
      ]);

      if (updatedEmployee) {
        await tx.insert(auditEvents).values({
          actorExternalUserId: input.actorExternalUserId,
          eventType: "employee.work_email.updated",
          entityType: "employee",
          entityId: updatedEmployee.id,
          beforeJson: {
            workEmail: previousWorkEmail
          },
          afterJson: {
            workEmail: updatedEmployee.workEmail
          },
          metadataJson: {
            access_request_id: input.context.accessRequest.id,
            access_task_id: task.id
          }
        });
      }

      return {
        task,
        grant
      };
    });
  }

  async completeConnectorAccessTask(input: CompleteConnectorAccessTaskInput): Promise<MockCompleteAccessTaskResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const accessRequest = input.context.accessRequest;

      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.completed,
          errorMessage: null,
          externalResultJson: input.connectorResult,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.context.task.id))
        .returning();

      const [grant] = await tx
        .insert(accessGrants)
        .values({
          employeeId: accessRequest.employeeId,
          systemId: accessRequest.systemId,
          resourceId: accessRequest.resourceId,
          roleId: accessRequest.roleId,
          status: ACCESS_GRANT_STATUS.active,
          externalAccountId: input.externalAccountId,
          grantedAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [
            accessGrants.employeeId,
            accessGrants.systemId,
            accessGrants.resourceId,
            accessGrants.roleId
          ],
          set: {
            status: ACCESS_GRANT_STATUS.active,
            externalAccountId: input.externalAccountId,
            grantedAt: now,
            revokedAt: null,
            updatedAt: now
          }
        })
        .returning();

      await tx
        .update(accessRequests)
        .set({
          status: ACCESS_REQUEST_STATUS.completed,
          updatedAt: now
        })
        .where(eq(accessRequests.id, accessRequest.id));

      const unblockedChannelTasks =
        input.context.system.key === SYSTEM_KEY.slack &&
        input.context.resource.key === ACCESS_RESOURCE_KEY.workspaceMembership &&
        input.context.accessRequest.action === ACCESS_REQUEST_ACTION.grant
          ? await this.unblockSlackChannelGrantTasksInTransaction(tx, {
              employeeId: accessRequest.employeeId,
              now
            })
          : [];

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_task.completed",
          entityType: "access_task",
          entityId: task.id,
          afterJson: task,
          metadataJson: {
            access_request_id: accessRequest.id
          }
        },
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_grant.activated",
          entityType: "access_grant",
          entityId: grant.id,
          afterJson: grant,
          metadataJson: {
            access_request_id: accessRequest.id,
            access_task_id: task.id
          }
        }
        ,
        ...unblockedChannelTasks.map((row) => ({
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_task.dependency_satisfied",
          entityType: "access_task",
          entityId: row.task.id,
          afterJson: row.task,
          metadataJson: {
            access_request_id: row.accessRequestId,
            dependency_access_task_id: task.id,
            dependency_resource: ACCESS_RESOURCE_KEY.workspaceMembership
          }
        }))
        ,
        ...(input.auditEvents ?? []).map((event) => ({
          actorExternalUserId: input.actorExternalUserId,
          eventType: event.eventType,
          entityType: event.entityType,
          entityId: event.entityId,
          afterJson: event.afterJson,
          metadataJson: event.metadataJson
        }))
      ]);

      return {
        task,
        grant
      };
    });
  }

  private async unblockSlackChannelGrantTasksInTransaction(
    tx: Parameters<Parameters<DatabaseProvider["db"]["transaction"]>[0]>[0],
    input: {
      employeeId: string;
      now: Date;
    }
  ): Promise<Array<{ task: AccessTask; accessRequestId: string }>> {
    const blockedChannelTasks = await tx
      .select({
        task: accessTasks,
        accessRequestId: accessRequests.id
      })
      .from(accessTasks)
      .innerJoin(accessRequests, eq(accessTasks.accessRequestId, accessRequests.id))
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessRequests.roleId, roles.id))
      .where(
        and(
          eq(accessRequests.employeeId, input.employeeId),
          eq(accessRequests.action, ACCESS_REQUEST_ACTION.grant),
          eq(systems.key, SYSTEM_KEY.slack),
          eq(accessResources.resourceType, ACCESS_RESOURCE_TYPE.channel),
          eq(roles.key, ROLE_KEY.member),
          eq(accessTasks.connector, SYSTEM_KEY.slack),
          eq(accessTasks.operation, ACCESS_TASK_OPERATION.grant),
          eq(accessTasks.status, ACCESS_TASK_STATUS.pendingDependency)
        )
      );

    const unblocked: Array<{ task: AccessTask; accessRequestId: string }> = [];

    for (const row of blockedChannelTasks) {
      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.pending,
          errorMessage: null,
          externalResultJson: null,
          updatedAt: input.now
        })
        .where(eq(accessTasks.id, row.task.id))
        .returning();

      unblocked.push({
        task,
        accessRequestId: row.accessRequestId
      });
    }

    return unblocked;
  }

  async completeRevokeAccessTask(input: CompleteRevokeAccessTaskInput): Promise<MockCompleteAccessTaskResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const accessRequest = input.context.accessRequest;

      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.completed,
          errorMessage: null,
          externalResultJson: input.connectorResult,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.context.task.id))
        .returning();

      await tx
        .update(accessRequests)
        .set({
          status: ACCESS_REQUEST_STATUS.completed,
          updatedAt: now
        })
        .where(eq(accessRequests.id, accessRequest.id));

      const [grant] = await tx
        .update(accessGrants)
        .set({
          status: ACCESS_GRANT_STATUS.revoked,
          revokedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(accessGrants.employeeId, accessRequest.employeeId),
            eq(accessGrants.systemId, accessRequest.systemId),
            eq(accessGrants.resourceId, accessRequest.resourceId),
            eq(accessGrants.roleId, accessRequest.roleId)
          )
        )
        .returning();

      if (!grant) {
        throw new Error("Revoke access task has no matching access grant.");
      }

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_task.completed",
          entityType: "access_task",
          entityId: task.id,
          afterJson: task,
          metadataJson: {
            access_request_id: accessRequest.id
          }
        },
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_grant.revoked",
          entityType: "access_grant",
          entityId: grant.id,
          afterJson: grant,
          metadataJson: {
            access_request_id: accessRequest.id,
            access_task_id: task.id
          }
        },
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "google_workspace.user_suspended",
          entityType: "access_task",
          entityId: task.id,
          afterJson: input.connectorResult,
          metadataJson: {
            access_request_id: accessRequest.id,
            employee_id: input.context.employee.id,
            primary_email: input.context.employee.workEmail,
            alreadySuspended: input.connectorResult.alreadySuspended === true,
            alreadyMissing: input.connectorResult.alreadyMissing === true
          }
        }
      ]);

      return {
        task,
        grant
      };
    });
  }

  async completeSlackChannelRevokeAccessTask(
    input: CompleteSlackChannelRevokeAccessTaskInput
  ): Promise<MockCompleteAccessTaskResult> {
    return this.completeSlackRevokeAccessTask(input, []);
  }

  async completeSlackChannelRevokeCoveredByWorkspaceTask(
    input: CompleteSlackChannelRevokeAccessTaskInput
  ): Promise<MockCompleteAccessTaskResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const accessRequest = input.context.accessRequest;

      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.skipped,
          errorMessage: "covered_by_workspace_membership_revoke",
          externalResultJson: input.connectorResult,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.context.task.id))
        .returning();

      await tx
        .update(accessRequests)
        .set({
          status: ACCESS_REQUEST_STATUS.completed,
          updatedAt: now
        })
        .where(eq(accessRequests.id, accessRequest.id));

      const [grant] = await tx
        .update(accessGrants)
        .set({
          status: ACCESS_GRANT_STATUS.revoked,
          revokedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(accessGrants.employeeId, accessRequest.employeeId),
            eq(accessGrants.systemId, accessRequest.systemId),
            eq(accessGrants.resourceId, accessRequest.resourceId),
            eq(accessGrants.roleId, accessRequest.roleId)
          )
        )
        .returning();

      if (!grant) {
        throw new Error("Covered Slack channel revoke task has no matching access grant.");
      }

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_task.skipped",
          entityType: "access_task",
          entityId: task.id,
          afterJson: task,
          metadataJson: {
            access_request_id: accessRequest.id,
            reason: "covered_by_workspace_membership_revoke"
          }
        },
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_grant.revoked",
          entityType: "access_grant",
          entityId: grant.id,
          afterJson: grant,
          metadataJson: {
            access_request_id: accessRequest.id,
            access_task_id: task.id,
            reason: "covered_by_workspace_membership_revoke"
          }
        }
      ]);

      return {
        task,
        grant
      };
    });
  }

  async completeSlackWorkspaceMembershipRevokeAccessTask(
    input: CompleteSlackWorkspaceMembershipRevokeAccessTaskInput
  ): Promise<MockCompleteAccessTaskResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const accessRequest = input.context.accessRequest;

      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.completed,
          errorMessage: null,
          externalResultJson: input.connectorResult,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.context.task.id))
        .returning();

      await tx
        .update(accessRequests)
        .set({
          status: ACCESS_REQUEST_STATUS.completed,
          updatedAt: now
        })
        .where(eq(accessRequests.id, accessRequest.id));

      const [workspaceGrant] = await tx
        .update(accessGrants)
        .set({
          status: ACCESS_GRANT_STATUS.revoked,
          revokedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(accessGrants.employeeId, accessRequest.employeeId),
            eq(accessGrants.systemId, accessRequest.systemId),
            eq(accessGrants.resourceId, accessRequest.resourceId),
            eq(accessGrants.roleId, accessRequest.roleId)
          )
        )
        .returning();

      if (!workspaceGrant) {
        throw new Error("Slack workspace revoke task has no matching access grant.");
      }

      const activeChannelGrants = await tx
        .select({ grant: accessGrants })
        .from(accessGrants)
        .innerJoin(systems, eq(accessGrants.systemId, systems.id))
        .innerJoin(accessResources, eq(accessGrants.resourceId, accessResources.id))
        .innerJoin(roles, eq(accessGrants.roleId, roles.id))
        .where(
          and(
            eq(accessGrants.employeeId, accessRequest.employeeId),
            eq(accessGrants.status, ACCESS_GRANT_STATUS.active),
            eq(systems.key, SYSTEM_KEY.slack),
            eq(accessResources.resourceType, ACCESS_RESOURCE_TYPE.channel),
            eq(roles.key, ROLE_KEY.member)
          )
        );

      const revokedChannelGrants = [];

      for (const row of activeChannelGrants) {
        const [grant] = await tx
          .update(accessGrants)
          .set({
            status: ACCESS_GRANT_STATUS.revoked,
            revokedAt: now,
            updatedAt: now
          })
          .where(eq(accessGrants.id, row.grant.id))
          .returning();

        if (grant) {
          revokedChannelGrants.push(grant);
        }
      }

      const pendingChannelTasks = await tx
        .select({
          task: accessTasks,
          accessRequest: accessRequests
        })
        .from(accessTasks)
        .innerJoin(accessRequests, eq(accessTasks.accessRequestId, accessRequests.id))
        .innerJoin(systems, eq(accessRequests.systemId, systems.id))
        .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
        .innerJoin(roles, eq(accessRequests.roleId, roles.id))
        .where(
          and(
            eq(accessRequests.employeeId, accessRequest.employeeId),
            eq(accessRequests.action, ACCESS_REQUEST_ACTION.revoke),
            eq(systems.key, SYSTEM_KEY.slack),
            eq(accessResources.resourceType, ACCESS_RESOURCE_TYPE.channel),
            eq(roles.key, ROLE_KEY.member),
            eq(accessTasks.connector, SYSTEM_KEY.slack),
            eq(accessTasks.operation, ACCESS_TASK_OPERATION.revoke),
            inArray(accessTasks.status, [
              ACCESS_TASK_STATUS.pending,
              ACCESS_TASK_STATUS.running,
              ACCESS_TASK_STATUS.retrying,
              ACCESS_TASK_STATUS.pendingDependency,
              ACCESS_TASK_STATUS.pendingManual
            ])
          )
        );

      const skippedChannelTasks = [];

      for (const row of pendingChannelTasks) {
        const coveredResult = {
          provider: SYSTEM_KEY.slack,
          operation: "remove_user_from_channel",
          coveredBy: "workspace_membership_revoke",
          reason: "covered_by_workspace_membership_revoke"
        };

        const [skippedTask] = await tx
          .update(accessTasks)
          .set({
            status: ACCESS_TASK_STATUS.skipped,
            errorMessage: "covered_by_workspace_membership_revoke",
            externalResultJson: coveredResult,
            updatedAt: now
          })
          .where(eq(accessTasks.id, row.task.id))
          .returning();

        await tx
          .update(accessRequests)
          .set({
            status: ACCESS_REQUEST_STATUS.completed,
            updatedAt: now
          })
          .where(eq(accessRequests.id, row.accessRequest.id));

        if (skippedTask) {
          skippedChannelTasks.push({
            task: skippedTask,
            accessRequest: row.accessRequest
          });
        }
      }

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_task.completed",
          entityType: "access_task",
          entityId: task.id,
          afterJson: task,
          metadataJson: {
            access_request_id: accessRequest.id
          }
        },
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_grant.revoked",
          entityType: "access_grant",
          entityId: workspaceGrant.id,
          afterJson: workspaceGrant,
          metadataJson: {
            access_request_id: accessRequest.id,
            access_task_id: task.id
          }
        },
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "slack.workspace_membership.revoked",
          entityType: "access_task",
          entityId: task.id,
          afterJson: input.connectorResult,
          metadataJson: {
            access_request_id: accessRequest.id,
            employee_id: input.context.employee.id,
            email: input.connectorResult.email,
            alreadyInactive: input.connectorResult.alreadyInactive === true
          }
        },
        ...revokedChannelGrants.map((grant) => ({
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_grant.revoked",
          entityType: "access_grant",
          entityId: grant.id,
          afterJson: grant,
          metadataJson: {
            access_request_id: accessRequest.id,
            access_task_id: task.id,
            reason: "revoked_by_slack_workspace_membership_revoke"
          }
        })),
        ...skippedChannelTasks.map((row) => ({
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_task.skipped",
          entityType: "access_task",
          entityId: row.task.id,
          afterJson: row.task,
          metadataJson: {
            access_request_id: row.accessRequest.id,
            reason: "covered_by_workspace_membership_revoke"
          }
        }))
      ]);

      return {
        task,
        grant: workspaceGrant
      };
    });
  }

  private async completeSlackRevokeAccessTask(
    input: CompleteRevokeAccessTaskInput,
    auditEventsForTask: Array<{
      eventType: string;
      entityType: string;
      entityId: string;
      afterJson?: Record<string, unknown>;
      metadataJson?: Record<string, unknown>;
    }>
  ): Promise<MockCompleteAccessTaskResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const accessRequest = input.context.accessRequest;

      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.completed,
          errorMessage: null,
          externalResultJson: input.connectorResult,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.context.task.id))
        .returning();

      await tx
        .update(accessRequests)
        .set({
          status: ACCESS_REQUEST_STATUS.completed,
          updatedAt: now
        })
        .where(eq(accessRequests.id, accessRequest.id));

      const [grant] = await tx
        .update(accessGrants)
        .set({
          status: ACCESS_GRANT_STATUS.revoked,
          revokedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(accessGrants.employeeId, accessRequest.employeeId),
            eq(accessGrants.systemId, accessRequest.systemId),
            eq(accessGrants.resourceId, accessRequest.resourceId),
            eq(accessGrants.roleId, accessRequest.roleId)
          )
        )
        .returning();

      if (!grant) {
        throw new Error("Slack revoke access task has no matching access grant.");
      }

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_task.completed",
          entityType: "access_task",
          entityId: task.id,
          afterJson: task,
          metadataJson: {
            access_request_id: accessRequest.id
          }
        },
        {
          actorExternalUserId: input.actorExternalUserId,
          eventType: "access_grant.revoked",
          entityType: "access_grant",
          entityId: grant.id,
          afterJson: grant,
          metadataJson: {
            access_request_id: accessRequest.id,
            access_task_id: task.id
          }
        },
        ...auditEventsForTask.map((event) => ({
          actorExternalUserId: input.actorExternalUserId,
          eventType: event.eventType,
          entityType: event.entityType,
          entityId: event.entityId,
          afterJson: event.afterJson,
          metadataJson: event.metadataJson
        }))
      ]);

      return {
        task,
        grant
      };
    });
  }

  async mockCompleteAccessTask(input: MockCompleteAccessTaskRepositoryInput): Promise<MockCompleteAccessTaskResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const accessRequest = input.context.accessRequest;

      if (input.context.task.status === ACCESS_TASK_STATUS.completed) {
        const [grant] = await tx
          .select()
          .from(accessGrants)
          .where(
            and(
              eq(accessGrants.employeeId, accessRequest.employeeId),
              eq(accessGrants.systemId, accessRequest.systemId),
              eq(accessGrants.resourceId, accessRequest.resourceId),
              eq(accessGrants.roleId, accessRequest.roleId)
            )
          )
          .limit(1);

        if (!grant) {
          throw new Error("Completed access task has no matching access grant.");
        }

        return {
          task: input.context.task,
          grant
        };
      }

      const now = new Date();
      const externalResultJson = input.externalResult ?? null;

      const [task] = await tx
        .update(accessTasks)
        .set({
          status: ACCESS_TASK_STATUS.completed,
          errorMessage: null,
          externalResultJson,
          updatedAt: now
        })
        .where(eq(accessTasks.id, input.context.task.id))
        .returning();

      const [grant] = await tx
        .insert(accessGrants)
        .values({
          employeeId: accessRequest.employeeId,
          systemId: accessRequest.systemId,
          resourceId: accessRequest.resourceId,
          roleId: accessRequest.roleId,
          status: ACCESS_GRANT_STATUS.active,
          externalAccountId: input.externalAccountId,
          grantedAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [
            accessGrants.employeeId,
            accessGrants.systemId,
            accessGrants.resourceId,
            accessGrants.roleId
          ],
          set: {
            status: ACCESS_GRANT_STATUS.active,
            externalAccountId: input.externalAccountId,
            grantedAt: now,
            revokedAt: null,
            updatedAt: now
          }
        })
        .returning();

      await tx
        .update(accessRequests)
        .set({
          status: ACCESS_REQUEST_STATUS.completed,
          updatedAt: now
        })
        .where(eq(accessRequests.id, accessRequest.id));

      await tx.insert(auditEvents).values([
        {
          actorExternalUserId: input.completedByExternalUserId,
          eventType: "access_task.completed",
          entityType: "access_task",
          entityId: task.id,
          afterJson: task,
          metadataJson: {
            access_request_id: accessRequest.id
          }
        },
        {
          actorExternalUserId: input.completedByExternalUserId,
          eventType: "access_grant.activated",
          entityType: "access_grant",
          entityId: grant.id,
          afterJson: grant,
          metadataJson: {
            access_request_id: accessRequest.id,
            access_task_id: task.id
          }
        }
      ]);

      return {
        task,
        grant
      };
    });
  }
}

function isTerminalSuccessfulOffboardingTask(task: AccessTask): boolean {
  if (task.status === ACCESS_TASK_STATUS.completed) {
    return true;
  }

  return (
    task.status === ACCESS_TASK_STATUS.skipped &&
    (
      task.errorMessage === "covered_by_workspace_membership_revoke" ||
      (
        typeof task.externalResultJson === "object" &&
        task.externalResultJson !== null &&
        "reason" in task.externalResultJson &&
        task.externalResultJson.reason === "covered_by_workspace_membership_revoke"
      )
    )
  );
}

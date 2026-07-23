import { Injectable } from "@nestjs/common";
import {
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_STATUS,
  ACCESS_GRANT_STATUS,
  ACCESS_TASK_STATUS,
  accessGrants,
  accessRequests,
  accessResources,
  accessTasks,
  AUDIT_ACTOR,
  APPROVAL_DECISION,
  approvals,
  auditEvents,
  employees,
  EMPLOYEE_STATUS,
  OFFBOARDING_INTAKE_APPROVAL_DECISION,
  offboardingIntakeApprovals,
  OFFBOARDING_INTAKE_STATUS,
  offboardingIntakes,
  OFFBOARDING_REVOKE_ITEM_STATUS,
  offboardingRevokeItems,
  roles,
  SYSTEM_KEY,
  systems
} from "@itops/db";
import { and, desc, eq, inArray } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";
import type { CreateOffboardingIntakeInput } from "./dto/create-offboarding-intake.dto.js";
import type { DecideOffboardingIntakeInput } from "./dto/decide-offboarding-intake.dto.js";

export type Employee = typeof employees.$inferSelect;
export type OffboardingIntake = typeof offboardingIntakes.$inferSelect;
export type OffboardingIntakeApproval = typeof offboardingIntakeApprovals.$inferSelect;
export type OffboardingRevokeItem = typeof offboardingRevokeItems.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
export type AccessTask = typeof accessTasks.$inferSelect;
export type AccessGrant = typeof accessGrants.$inferSelect;

type Transaction = Parameters<Parameters<DatabaseProvider["db"]["transaction"]>[0]>[0];

export type ActiveAccessPreviewItem = {
  grantId: string;
  system: {
    id: string;
    key: string;
    name: string;
  };
  resource: {
    id: string;
    key: string;
    name: string;
    resourceType: string;
  };
  role: {
    id: string;
    key: string;
    name: string;
    riskLevel: "low" | "medium" | "high" | "critical";
  };
  status: "active";
};

export type OffboardingRevokeItemDetail = Pick<
  OffboardingRevokeItem,
  "id" | "accessGrantId" | "accessRequestId" | "accessTaskId" | "status" | "errorMessage"
> & {
  system: {
    id: string;
    key: string;
    name: string;
  };
  resource: {
    id: string;
    key: string;
    name: string;
    resourceType: string;
  };
  role: {
    id: string;
    key: string;
    name: string;
    riskLevel: "low" | "medium" | "high" | "critical";
  };
};

export type OffboardingStatusRevokeItem = {
  id: string;
  system: {
    id: string;
    key: string;
    name: string;
  };
  resource: {
    id: string;
    key: string;
    name: string;
    resourceType: string;
  };
  role: {
    id: string;
    key: string;
    name: string;
    riskLevel: "low" | "medium" | "high" | "critical";
  };
  grantStatus: string;
  taskStatus: string | null;
  accessTaskId: string | null;
  accessGrantId: string;
  accessRequestId: string | null;
  revokeItemStatus: string;
  errorMessage: string | null;
  taskErrorMessage: string | null;
  taskExternalResultJson: Record<string, unknown> | null;
};

export type OffboardingProgressSummary = {
  total: number;
  completed: number;
  pending: number;
  failed: number;
};

export type OffboardingWorkflowState =
  | "waiting_for_approval"
  | "approved"
  | "revoke_tasks_created"
  | "revoking"
  | "revoked"
  | "finalized"
  | "cancelled"
  | "failed";

export type OffboardingEmployeeLifecycleCase =
  | "preboarding_cancellation"
  | "active_offboarding"
  | "already_offboarding"
  | "already_offboarded";

type OffboardingIntakeStatusValue = (typeof OFFBOARDING_INTAKE_STATUS)[keyof typeof OFFBOARDING_INTAKE_STATUS];

export type OffboardingStatusResult = {
  offboardingIntake: OffboardingIntake;
  employee: Employee;
  summary: OffboardingProgressSummary;
  revokeItems: OffboardingStatusRevokeItem[];
  canFinalize: boolean;
  workflowState: OffboardingWorkflowState;
  employeeLifecycleCase: OffboardingEmployeeLifecycleCase;
};

export type FinalizeOffboardingResult = OffboardingStatusResult;

export type OffboardingDecisionRevokeItem = {
  grantId: string;
  accessRequestId: string;
  accessTaskId: string;
  system: {
    id: string;
    key: string;
    name: string;
  };
  resource: {
    id: string;
    key: string;
    name: string;
    resourceType: string;
  };
  role: {
    id: string;
    key: string;
    name: string;
    riskLevel: "low" | "medium" | "high" | "critical";
  };
  taskStatus: "pending" | "pending_manual";
};

export type DecideOffboardingIntakeResult = {
  offboardingIntake: OffboardingIntake;
  decision: OffboardingIntakeApproval;
  employee: Employee | null;
  revokeItems: OffboardingDecisionRevokeItem[];
  status: string;
  nextAction?: "execute_revoke_tasks";
};

type DecideOffboardingIntakeRepositoryInput = DecideOffboardingIntakeInput & {
  offboardingIntake: OffboardingIntake;
};

type CreateOffboardingIntakeRepositoryInput = Pick<
  CreateOffboardingIntakeInput,
  "requestedByExternalUserId" | "reason" | "lastWorkingDay" | "notes"
> & {
  employeeId: string;
  activeAccessCount: number;
  employeeStatusAtCreation: string;
};

const OPEN_REVOKE_REQUEST_STATUSES = [
  ACCESS_REQUEST_STATUS.draft,
  ACCESS_REQUEST_STATUS.waitingForApproval,
  ACCESS_REQUEST_STATUS.approved,
  ACCESS_REQUEST_STATUS.provisioning
] as const;

@Injectable()
export class OffboardingRepository {
  constructor(private readonly databaseProvider: DatabaseProvider) {}

  async findEmployeeById(id: string): Promise<Employee | undefined> {
    const [employee] = await this.databaseProvider.db.select().from(employees).where(eq(employees.id, id)).limit(1);
    return employee;
  }

  async findOffboardingIntakeById(id: string): Promise<OffboardingIntake | undefined> {
    const [offboardingIntake] = await this.databaseProvider.db
      .select()
      .from(offboardingIntakes)
      .where(eq(offboardingIntakes.id, id))
      .limit(1);

    return offboardingIntake;
  }

  async findLatestOffboardingIntakeForEmployee(input: {
    employeeId: string;
    statuses?: OffboardingIntakeStatusValue[];
  }): Promise<OffboardingIntake | undefined> {
    const filters = [eq(offboardingIntakes.employeeId, input.employeeId)];

    if (input.statuses && input.statuses.length > 0) {
      filters.push(inArray(offboardingIntakes.status, input.statuses));
    }

    const [offboardingIntake] = await this.databaseProvider.db
      .select()
      .from(offboardingIntakes)
      .where(and(...filters))
      .orderBy(desc(offboardingIntakes.createdAt))
      .limit(1);

    return offboardingIntake;
  }

  async createOffboardingIntake(input: CreateOffboardingIntakeRepositoryInput): Promise<OffboardingIntake> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const [offboardingIntake] = await tx
        .insert(offboardingIntakes)
        .values({
          employeeId: input.employeeId,
          requestedByExternalUserId: input.requestedByExternalUserId,
          reason: input.reason ?? null,
          lastWorkingDay: input.lastWorkingDay ?? null,
          notes: input.notes ?? null,
          status: OFFBOARDING_INTAKE_STATUS.waitingForReview
        })
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.requestedByExternalUserId,
        eventType: "offboarding_intake.created",
        entityType: "offboarding_intake",
        entityId: offboardingIntake.id,
        afterJson: offboardingIntake,
        metadataJson: {
          employee_id: input.employeeId,
          activeAccessCount: input.activeAccessCount,
          employee_status_at_creation: input.employeeStatusAtCreation
        }
      });

      return offboardingIntake;
    });
  }

  async listActiveAccessPreviewForEmployee(employeeId: string): Promise<ActiveAccessPreviewItem[]> {
    const rows = await this.databaseProvider.db
      .select({
        grant: {
          id: accessGrants.id
        },
        system: {
          id: systems.id,
          key: systems.key,
          name: systems.name
        },
        resource: {
          id: accessResources.id,
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          id: roles.id,
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        }
      })
      .from(accessGrants)
      .innerJoin(systems, eq(accessGrants.systemId, systems.id))
      .innerJoin(accessResources, eq(accessGrants.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessGrants.roleId, roles.id))
      .where(and(eq(accessGrants.employeeId, employeeId), eq(accessGrants.status, ACCESS_GRANT_STATUS.active)))
      .orderBy(desc(accessGrants.grantedAt), desc(accessGrants.createdAt));

    return rows.map((row) => ({
      grantId: row.grant.id,
      system: row.system,
      resource: row.resource,
      role: row.role,
      status: ACCESS_GRANT_STATUS.active
    }));
  }

  async listRevokeItemsForOffboardingIntake(offboardingIntakeId: string): Promise<OffboardingRevokeItemDetail[]> {
    const rows = await this.databaseProvider.db
      .select({
        revokeItem: {
          id: offboardingRevokeItems.id,
          accessGrantId: offboardingRevokeItems.accessGrantId,
          accessRequestId: offboardingRevokeItems.accessRequestId,
          accessTaskId: offboardingRevokeItems.accessTaskId,
          status: offboardingRevokeItems.status,
          errorMessage: offboardingRevokeItems.errorMessage
        },
        system: {
          id: systems.id,
          key: systems.key,
          name: systems.name
        },
        resource: {
          id: accessResources.id,
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          id: roles.id,
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        }
      })
      .from(offboardingRevokeItems)
      .innerJoin(systems, eq(offboardingRevokeItems.systemId, systems.id))
      .innerJoin(accessResources, eq(offboardingRevokeItems.resourceId, accessResources.id))
      .innerJoin(roles, eq(offboardingRevokeItems.roleId, roles.id))
      .where(eq(offboardingRevokeItems.offboardingIntakeId, offboardingIntakeId))
      .orderBy(desc(offboardingRevokeItems.createdAt));

    return rows.map((row) => ({
      ...row.revokeItem,
      system: row.system,
      resource: row.resource,
      role: row.role
    }));
  }

  async getOffboardingStatus(input: {
    offboardingIntake: OffboardingIntake;
    employee: Employee;
  }): Promise<OffboardingStatusResult> {
    const revokeItems = await this.listOffboardingStatusRevokeItems(input.offboardingIntake.id);
    const employeeStatusAtCreation = await this.findOffboardingIntakeCreatedEmployeeStatus(input.offboardingIntake.id);

    return buildOffboardingStatusResult({
      offboardingIntake: input.offboardingIntake,
      employee: input.employee,
      revokeItems,
      employeeStatusAtCreation
    });
  }

  async findOffboardingIntakeCreatedEmployeeStatus(offboardingIntakeId: string): Promise<string | undefined> {
    const [event] = await this.databaseProvider.db
      .select({
        metadataJson: auditEvents.metadataJson
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "offboarding_intake.created"),
          eq(auditEvents.entityType, "offboarding_intake"),
          eq(auditEvents.entityId, offboardingIntakeId)
        )
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);

    const metadata = event?.metadataJson;

    if (metadata && typeof metadata.employee_status_at_creation === "string") {
      return metadata.employee_status_at_creation;
    }

    return undefined;
  }

  async finalizeOffboarding(input: {
    offboardingIntake: OffboardingIntake;
    employee: Employee;
  }): Promise<FinalizeOffboardingResult> {
    const employeeStatusAtCreation = await this.findOffboardingIntakeCreatedEmployeeStatus(input.offboardingIntake.id);

    return this.databaseProvider.db.transaction(async (tx) => {
      const revokeItems = await this.listOffboardingStatusRevokeItemsInTransaction(tx, input.offboardingIntake.id);
      const currentStatus = buildOffboardingStatusResult({
        offboardingIntake: input.offboardingIntake,
        employee: input.employee,
        revokeItems,
        employeeStatusAtCreation
      });

      if (!currentStatus.canFinalize) {
        return currentStatus;
      }

      const now = new Date();
      const [offboardingIntake] = await tx
        .update(offboardingIntakes)
        .set({
          status: OFFBOARDING_INTAKE_STATUS.completed,
          completedAt: now,
          updatedAt: now
        })
        .where(eq(offboardingIntakes.id, input.offboardingIntake.id))
        .returning();

      const employeeUpdate = {
        status: EMPLOYEE_STATUS.offboarded,
        endDate: input.employee.endDate ?? input.offboardingIntake.lastWorkingDay ?? null,
        updatedAt: now
      };

      const [employee] = await tx
        .update(employees)
        .set(employeeUpdate)
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
            revoke_item_count: revokeItems.length
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
            offboarding_intake_id: offboardingIntake.id
          }
        }
      ]);

      const finalizedRevokeItems = await this.listOffboardingStatusRevokeItemsInTransaction(tx, offboardingIntake.id);

      return buildOffboardingStatusResult({
        offboardingIntake,
        employee,
        revokeItems: finalizedRevokeItems,
        employeeStatusAtCreation
      });
    });
  }

  async listOffboardingStatusRevokeItems(offboardingIntakeId: string): Promise<OffboardingStatusRevokeItem[]> {
    return this.listOffboardingStatusRevokeItemsInTransaction(this.databaseProvider.db, offboardingIntakeId);
  }

  async findApprovedOffboardingIntakeDecision(
    offboardingIntakeId: string
  ): Promise<OffboardingIntakeApproval | undefined> {
    const [decision] = await this.databaseProvider.db
      .select()
      .from(offboardingIntakeApprovals)
      .where(
        and(
          eq(offboardingIntakeApprovals.offboardingIntakeId, offboardingIntakeId),
          eq(offboardingIntakeApprovals.decision, OFFBOARDING_INTAKE_APPROVAL_DECISION.approved)
        )
      )
      .limit(1);

    return decision;
  }

  private async listOffboardingStatusRevokeItemsInTransaction(
    tx: Transaction | DatabaseProvider["db"],
    offboardingIntakeId: string
  ): Promise<OffboardingStatusRevokeItem[]> {
    const rows = await tx
      .select({
        revokeItem: {
          id: offboardingRevokeItems.id,
          accessGrantId: offboardingRevokeItems.accessGrantId,
          accessRequestId: offboardingRevokeItems.accessRequestId,
          accessTaskId: offboardingRevokeItems.accessTaskId,
          status: offboardingRevokeItems.status,
          errorMessage: offboardingRevokeItems.errorMessage
        },
        grant: {
          status: accessGrants.status
        },
        accessTask: {
          id: accessTasks.id,
          status: accessTasks.status,
          errorMessage: accessTasks.errorMessage,
          externalResultJson: accessTasks.externalResultJson
        },
        system: {
          id: systems.id,
          key: systems.key,
          name: systems.name
        },
        resource: {
          id: accessResources.id,
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          id: roles.id,
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        }
      })
      .from(offboardingRevokeItems)
      .innerJoin(accessGrants, eq(offboardingRevokeItems.accessGrantId, accessGrants.id))
      .leftJoin(accessTasks, eq(offboardingRevokeItems.accessTaskId, accessTasks.id))
      .innerJoin(systems, eq(offboardingRevokeItems.systemId, systems.id))
      .innerJoin(accessResources, eq(offboardingRevokeItems.resourceId, accessResources.id))
      .innerJoin(roles, eq(offboardingRevokeItems.roleId, roles.id))
      .where(eq(offboardingRevokeItems.offboardingIntakeId, offboardingIntakeId))
      .orderBy(desc(offboardingRevokeItems.createdAt));

    return rows.map((row) => ({
      id: row.revokeItem.id,
      system: row.system,
      resource: row.resource,
      role: row.role,
      grantStatus: row.grant.status,
      taskStatus: row.accessTask?.status ?? null,
      accessTaskId: row.accessTask?.id ?? row.revokeItem.accessTaskId,
      accessGrantId: row.revokeItem.accessGrantId,
      accessRequestId: row.revokeItem.accessRequestId,
      revokeItemStatus: row.revokeItem.status,
      errorMessage: row.revokeItem.errorMessage,
      taskErrorMessage: row.accessTask?.errorMessage ?? null,
      taskExternalResultJson: row.accessTask?.externalResultJson ?? null
    }));
  }

  async recordOffboardingApprovalDeniedByPolicy(input: {
    offboardingIntake: OffboardingIntake;
    approverExternalUserId: string;
    reason: string;
  }): Promise<void> {
    await this.databaseProvider.db.insert(auditEvents).values({
      actorExternalUserId: input.approverExternalUserId,
      eventType: "offboarding_intake.approval_denied_by_policy",
      entityType: "offboarding_intake",
      entityId: input.offboardingIntake.id,
      metadataJson: {
        reason: input.reason
      }
    });
  }

  async recordOffboardingTransitionDenied(input: {
    offboardingIntake?: OffboardingIntake;
    employee?: Employee;
    actorExternalUserId: string;
    attemptedAction: string;
    currentState: string;
    reason: string;
  }): Promise<void> {
    const entityType = input.offboardingIntake ? "offboarding_intake" : "employee";
    const entityId = input.offboardingIntake?.id ?? input.employee?.id ?? null;

    await this.databaseProvider.db.insert(auditEvents).values({
      actorExternalUserId: input.actorExternalUserId,
      eventType: "offboarding.transition_denied",
      entityType,
      entityId,
      metadataJson: {
        attempted_action: input.attemptedAction,
        current_state: input.currentState,
        reason: input.reason,
        employee_id: input.employee?.id ?? input.offboardingIntake?.employeeId ?? null
      }
    });
  }

  async rejectOffboardingIntake(input: DecideOffboardingIntakeRepositoryInput): Promise<DecideOffboardingIntakeResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const [decision] = await tx
        .insert(offboardingIntakeApprovals)
        .values({
          offboardingIntakeId: input.offboardingIntake.id,
          approverExternalUserId: input.approverExternalUserId,
          decision: input.decision,
          comment: input.comment ?? null,
          source: input.source,
          gantryConversationId: input.gantryConversationId ?? null,
          gantryRuntimeEventId: input.gantryRuntimeEventId ?? null
        })
        .returning();

      const [offboardingIntake] = await tx
        .update(offboardingIntakes)
        .set({
          status: OFFBOARDING_INTAKE_STATUS.rejected,
          rejectedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(offboardingIntakes.id, input.offboardingIntake.id))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.approverExternalUserId,
        eventType: "offboarding_intake.rejected",
        entityType: "offboarding_intake",
        entityId: offboardingIntake.id,
        afterJson: offboardingIntake,
        metadataJson: {
          decision_id: decision.id,
          comment: input.comment ?? null
        }
      });

      return {
        offboardingIntake,
        decision,
        employee: null,
        revokeItems: [],
        status: offboardingIntake.status
      };
    });
  }

  async approveOffboardingIntake(input: DecideOffboardingIntakeRepositoryInput): Promise<DecideOffboardingIntakeResult> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const employee = await this.findEmployeeByIdInTransaction(tx, input.offboardingIntake.employeeId);

      if (!employee) {
        throw new Error("Offboarding intake employee is missing.");
      }

      const decision = await this.createOrFindOffboardingDecisionInTransaction(tx, input);
      const activeGrants = await this.listActiveGrantContextsForEmployeeInTransaction(tx, employee.id);
      const revokeItems: OffboardingDecisionRevokeItem[] = [];

      for (const grantContext of activeGrants) {
        const revokeItem = await this.createOrFindRevokeItemInTransaction(tx, {
          offboardingIntakeId: input.offboardingIntake.id,
          grantContext
        });
        const accessRequest = await this.createOrFindRevokeAccessRequestInTransaction(tx, {
          revokeItem,
          grantContext,
          offboardingIntake: input.offboardingIntake
        });

        await this.createOrFindAccessRequestApprovalInTransaction(tx, {
          accessRequest,
          input,
          offboardingDecisionId: decision.id
        });

        const accessTask = await this.createOrFindRevokeAccessTaskInTransaction(tx, {
          accessRequest,
          grantContext,
          actorExternalUserId: input.approverExternalUserId
        });
        const updatedRevokeItem = await this.updateRevokeItemTaskCreatedInTransaction(tx, {
          revokeItemId: revokeItem.id,
          accessRequestId: accessRequest.id,
          accessTaskId: accessTask.id
        });

        revokeItems.push({
          grantId: updatedRevokeItem.accessGrantId,
          accessRequestId: accessRequest.id,
          accessTaskId: accessTask.id,
          system: grantContext.system,
          resource: grantContext.resource,
          role: grantContext.role,
          taskStatus: accessTask.status as "pending" | "pending_manual"
        });
      }

      const shouldMarkApproved = input.offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.waitingForReview;
      const updatedEmployee = shouldMarkApproved
        ? await this.markEmployeeOffboardingInTransaction(tx, employee.id)
        : employee;
      const offboardingIntake = shouldMarkApproved
        ? await this.markOffboardingIntakeApprovedInTransaction(tx, input.offboardingIntake.id)
        : input.offboardingIntake;

      if (shouldMarkApproved) {
        await tx.insert(auditEvents).values([
          {
            actorExternalUserId: input.approverExternalUserId,
            eventType: "offboarding_intake.approved",
            entityType: "offboarding_intake",
            entityId: offboardingIntake.id,
            afterJson: offboardingIntake,
            metadataJson: {
              decision_id: decision.id
            }
          },
          {
            actorExternalUserId: input.approverExternalUserId,
            eventType: "offboarding.revoke_items_created",
            entityType: "offboarding_intake",
            entityId: offboardingIntake.id,
            metadataJson: {
              revoke_item_count: revokeItems.length
            }
          }
        ]);
      }

      return {
        offboardingIntake,
        decision,
        employee: updatedEmployee,
        revokeItems,
        status: offboardingIntake.status,
        nextAction: "execute_revoke_tasks"
      };
    });
  }

  async getApprovedOffboardingDecisionState(input: {
    offboardingIntake: OffboardingIntake;
    decision: OffboardingIntakeApproval;
  }): Promise<DecideOffboardingIntakeResult> {
    const [employee, revokeItems] = await Promise.all([
      this.findEmployeeById(input.offboardingIntake.employeeId),
      this.listDecisionRevokeItemsForOffboardingIntake(input.offboardingIntake.id)
    ]);

    return {
      offboardingIntake: input.offboardingIntake,
      decision: input.decision,
      employee: employee ?? null,
      revokeItems,
      status: input.offboardingIntake.status,
      nextAction: "execute_revoke_tasks"
    };
  }

  async listDecisionRevokeItemsForOffboardingIntake(
    offboardingIntakeId: string
  ): Promise<OffboardingDecisionRevokeItem[]> {
    const rows = await this.databaseProvider.db
      .select({
        revokeItem: {
          accessGrantId: offboardingRevokeItems.accessGrantId
        },
        accessRequest: {
          id: accessRequests.id
        },
        accessTask: {
          id: accessTasks.id,
          status: accessTasks.status
        },
        system: {
          id: systems.id,
          key: systems.key,
          name: systems.name
        },
        resource: {
          id: accessResources.id,
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          id: roles.id,
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        }
      })
      .from(offboardingRevokeItems)
      .innerJoin(accessRequests, eq(offboardingRevokeItems.accessRequestId, accessRequests.id))
      .innerJoin(accessTasks, eq(offboardingRevokeItems.accessTaskId, accessTasks.id))
      .innerJoin(systems, eq(offboardingRevokeItems.systemId, systems.id))
      .innerJoin(accessResources, eq(offboardingRevokeItems.resourceId, accessResources.id))
      .innerJoin(roles, eq(offboardingRevokeItems.roleId, roles.id))
      .where(eq(offboardingRevokeItems.offboardingIntakeId, offboardingIntakeId))
      .orderBy(desc(offboardingRevokeItems.createdAt));

    return rows.map((row) => ({
      grantId: row.revokeItem.accessGrantId,
      accessRequestId: row.accessRequest.id,
      accessTaskId: row.accessTask.id,
      system: row.system,
      resource: row.resource,
      role: row.role,
      taskStatus: row.accessTask.status as "pending" | "pending_manual"
    }));
  }

  private async findEmployeeByIdInTransaction(tx: Transaction, id: string): Promise<Employee | undefined> {
    const [employee] = await tx.select().from(employees).where(eq(employees.id, id)).limit(1);
    return employee;
  }

  private async createOrFindOffboardingDecisionInTransaction(
    tx: Transaction,
    input: DecideOffboardingIntakeRepositoryInput
  ): Promise<OffboardingIntakeApproval> {
    const [existingDecision] = await tx
      .select()
      .from(offboardingIntakeApprovals)
      .where(
        and(
          eq(offboardingIntakeApprovals.offboardingIntakeId, input.offboardingIntake.id),
          eq(offboardingIntakeApprovals.decision, OFFBOARDING_INTAKE_APPROVAL_DECISION.approved)
        )
      )
      .limit(1);

    if (existingDecision) {
      return existingDecision;
    }

    const [decision] = await tx
      .insert(offboardingIntakeApprovals)
      .values({
        offboardingIntakeId: input.offboardingIntake.id,
        approverExternalUserId: input.approverExternalUserId,
        decision: input.decision,
        comment: input.comment ?? null,
        source: input.source,
        gantryConversationId: input.gantryConversationId ?? null,
        gantryRuntimeEventId: input.gantryRuntimeEventId ?? null
      })
      .returning();

    return decision;
  }

  private async listActiveGrantContextsForEmployeeInTransaction(
    tx: Transaction,
    employeeId: string
  ): Promise<
    Array<{
      grant: typeof accessGrants.$inferSelect;
      system: Pick<typeof systems.$inferSelect, "id" | "key" | "name">;
      resource: Pick<typeof accessResources.$inferSelect, "id" | "key" | "name" | "resourceType">;
      role: Pick<typeof roles.$inferSelect, "id" | "key" | "name" | "riskLevel">;
    }>
  > {
    return tx
      .select({
        grant: accessGrants,
        system: {
          id: systems.id,
          key: systems.key,
          name: systems.name
        },
        resource: {
          id: accessResources.id,
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        },
        role: {
          id: roles.id,
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        }
      })
      .from(accessGrants)
      .innerJoin(systems, eq(accessGrants.systemId, systems.id))
      .innerJoin(accessResources, eq(accessGrants.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessGrants.roleId, roles.id))
      .where(and(eq(accessGrants.employeeId, employeeId), eq(accessGrants.status, ACCESS_GRANT_STATUS.active)))
      .orderBy(desc(accessGrants.grantedAt), desc(accessGrants.createdAt));
  }

  private async createOrFindRevokeItemInTransaction(
    tx: Transaction,
    input: {
      offboardingIntakeId: string;
      grantContext: Awaited<ReturnType<OffboardingRepository["listActiveGrantContextsForEmployeeInTransaction"]>>[number];
    }
  ): Promise<OffboardingRevokeItem> {
    const [createdRevokeItem] = await tx
      .insert(offboardingRevokeItems)
      .values({
        offboardingIntakeId: input.offboardingIntakeId,
        accessGrantId: input.grantContext.grant.id,
        systemId: input.grantContext.grant.systemId,
        resourceId: input.grantContext.grant.resourceId,
        roleId: input.grantContext.grant.roleId,
        status: OFFBOARDING_REVOKE_ITEM_STATUS.pending
      })
      .onConflictDoNothing({
        target: [offboardingRevokeItems.offboardingIntakeId, offboardingRevokeItems.accessGrantId]
      })
      .returning();

    if (createdRevokeItem) {
      return createdRevokeItem;
    }

    const [existingRevokeItem] = await tx
      .select()
      .from(offboardingRevokeItems)
      .where(
        and(
          eq(offboardingRevokeItems.offboardingIntakeId, input.offboardingIntakeId),
          eq(offboardingRevokeItems.accessGrantId, input.grantContext.grant.id)
        )
      )
      .limit(1);

    if (!existingRevokeItem) {
      throw new Error("Offboarding revoke item idempotency lookup failed.");
    }

    return existingRevokeItem;
  }

  private async createOrFindRevokeAccessRequestInTransaction(
    tx: Transaction,
    input: {
      revokeItem: OffboardingRevokeItem;
      grantContext: Awaited<ReturnType<OffboardingRepository["listActiveGrantContextsForEmployeeInTransaction"]>>[number];
      offboardingIntake: OffboardingIntake;
    }
  ): Promise<AccessRequest> {
    if (input.revokeItem.accessRequestId) {
      const [existingLinkedRequest] = await tx
        .select()
        .from(accessRequests)
        .where(eq(accessRequests.id, input.revokeItem.accessRequestId))
        .limit(1);

      if (existingLinkedRequest) {
        return this.ensureAccessRequestApprovedInTransaction(tx, existingLinkedRequest);
      }
    }

    const [existingOpenRequest] = await tx
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.employeeId, input.grantContext.grant.employeeId),
          eq(accessRequests.systemId, input.grantContext.grant.systemId),
          eq(accessRequests.resourceId, input.grantContext.grant.resourceId),
          eq(accessRequests.roleId, input.grantContext.grant.roleId),
          eq(accessRequests.action, ACCESS_REQUEST_ACTION.revoke),
          inArray(accessRequests.status, [...OPEN_REVOKE_REQUEST_STATUSES])
        )
      )
      .limit(1);

    if (existingOpenRequest) {
      return this.ensureAccessRequestApprovedInTransaction(tx, existingOpenRequest);
    }

    const [accessRequest] = await tx
      .insert(accessRequests)
      .values({
        employeeId: input.grantContext.grant.employeeId,
        systemId: input.grantContext.grant.systemId,
        resourceId: input.grantContext.grant.resourceId,
        roleId: input.grantContext.grant.roleId,
        action: ACCESS_REQUEST_ACTION.revoke,
        status: ACCESS_REQUEST_STATUS.approved,
        reason: "Access revocation required for offboarding",
        requestedByExternalUserId: input.offboardingIntake.requestedByExternalUserId,
        requestedFrom: "offboarding_intake"
      })
      .returning();

    return accessRequest;
  }

  private async ensureAccessRequestApprovedInTransaction(
    tx: Transaction,
    accessRequest: AccessRequest
  ): Promise<AccessRequest> {
    if (accessRequest.status === ACCESS_REQUEST_STATUS.approved) {
      return accessRequest;
    }

    const [approvedAccessRequest] = await tx
      .update(accessRequests)
      .set({
        status: ACCESS_REQUEST_STATUS.approved,
        updatedAt: new Date()
      })
      .where(eq(accessRequests.id, accessRequest.id))
      .returning();

    return approvedAccessRequest;
  }

  private async createOrFindAccessRequestApprovalInTransaction(
    tx: Transaction,
    input: {
      accessRequest: AccessRequest;
      input: DecideOffboardingIntakeRepositoryInput;
      offboardingDecisionId: string;
    }
  ): Promise<typeof approvals.$inferSelect> {
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
        comment: input.input.comment ?? "Approved as part of offboarding intake approval",
        source: "offboarding_intake",
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
        offboarding_intake_id: input.input.offboardingIntake.id,
        offboarding_decision_id: input.offboardingDecisionId
      }
    });

    return approval;
  }

  private async createOrFindRevokeAccessTaskInTransaction(
    tx: Transaction,
    input: {
      accessRequest: AccessRequest;
      grantContext: Awaited<ReturnType<OffboardingRepository["listActiveGrantContextsForEmployeeInTransaction"]>>[number];
      actorExternalUserId: string;
    }
  ): Promise<AccessTask> {
    const idempotencyKey = [
      ACCESS_REQUEST_ACTION.revoke,
      input.grantContext.grant.employeeId,
      input.grantContext.system.key,
      input.grantContext.resource.key,
      input.grantContext.role.key
    ].join(":");

    const [createdTask] = await tx
      .insert(accessTasks)
      .values({
        accessRequestId: input.accessRequest.id,
        operation: ACCESS_REQUEST_ACTION.revoke,
        connector: input.grantContext.system.key,
        status: taskStatusForSystem(input.grantContext.system.key),
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

  private async updateRevokeItemTaskCreatedInTransaction(
    tx: Transaction,
    input: {
      revokeItemId: string;
      accessRequestId: string;
      accessTaskId: string;
    }
  ): Promise<OffboardingRevokeItem> {
    const [revokeItem] = await tx
      .update(offboardingRevokeItems)
      .set({
        accessRequestId: input.accessRequestId,
        accessTaskId: input.accessTaskId,
        status: OFFBOARDING_REVOKE_ITEM_STATUS.taskCreated,
        updatedAt: new Date()
      })
      .where(eq(offboardingRevokeItems.id, input.revokeItemId))
      .returning();

    return revokeItem;
  }

  private async markEmployeeOffboardingInTransaction(tx: Transaction, employeeId: string): Promise<Employee> {
    const [employee] = await tx
      .update(employees)
      .set({
        status: EMPLOYEE_STATUS.offboarding,
        updatedAt: new Date()
      })
      .where(eq(employees.id, employeeId))
      .returning();

    return employee;
  }

  private async markOffboardingIntakeApprovedInTransaction(
    tx: Transaction,
    offboardingIntakeId: string
  ): Promise<OffboardingIntake> {
    const [offboardingIntake] = await tx
      .update(offboardingIntakes)
      .set({
        status: OFFBOARDING_INTAKE_STATUS.inProgress,
        approvedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(offboardingIntakes.id, offboardingIntakeId))
      .returning();

    return offboardingIntake;
  }
}

function taskStatusForSystem(systemKey: string): "pending" | "pending_manual" {
  return systemKey === SYSTEM_KEY.googleWorkspace || systemKey === SYSTEM_KEY.slack
    ? ACCESS_TASK_STATUS.pending
    : ACCESS_TASK_STATUS.pendingManual;
}

function buildOffboardingStatusResult(input: {
  offboardingIntake: OffboardingIntake;
  employee: Employee;
  revokeItems: OffboardingStatusRevokeItem[];
  employeeStatusAtCreation?: string;
}): OffboardingStatusResult {
  const summary = input.revokeItems.reduce<OffboardingProgressSummary>((accumulator, item) => {
    accumulator.total += 1;

    if (isTerminalSuccessfulRevokeItem(item)) {
      accumulator.completed += 1;
      return accumulator;
    }

    if (item.taskStatus === ACCESS_TASK_STATUS.failed || item.revokeItemStatus === OFFBOARDING_REVOKE_ITEM_STATUS.failed) {
      accumulator.failed += 1;
      return accumulator;
    }

    accumulator.pending += 1;
    return accumulator;
  }, {
    total: 0,
    completed: 0,
    pending: 0,
    failed: 0
  });

  return {
    offboardingIntake: input.offboardingIntake,
    employee: input.employee,
    summary,
    revokeItems: input.revokeItems,
    canFinalize: summary.failed === 0 && summary.pending === 0,
    workflowState: deriveOffboardingWorkflowState({
      offboardingIntake: input.offboardingIntake,
      summary,
      revokeItems: input.revokeItems
    }),
    employeeLifecycleCase: lifecycleCaseForEmployeeStatus(input.employeeStatusAtCreation ?? input.employee.status)
  };
}

export function lifecycleCaseForEmployeeStatus(status: string): OffboardingEmployeeLifecycleCase {
  if (status === EMPLOYEE_STATUS.preboarding) {
    return "preboarding_cancellation";
  }

  if (status === EMPLOYEE_STATUS.offboarding) {
    return "already_offboarding";
  }

  if (status === EMPLOYEE_STATUS.offboarded) {
    return "already_offboarded";
  }

  return "active_offboarding";
}

function deriveOffboardingWorkflowState(input: {
  offboardingIntake: OffboardingIntake;
  summary: OffboardingProgressSummary;
  revokeItems: OffboardingStatusRevokeItem[];
}): OffboardingWorkflowState {
  if (input.offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.completed) {
    return "finalized";
  }

  if (input.offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.cancelled) {
    return "cancelled";
  }

  if (
    input.offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.failed ||
    input.offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.rejected ||
    input.summary.failed > 0
  ) {
    return "failed";
  }

  if (input.offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.waitingForReview) {
    return "waiting_for_approval";
  }

  if (input.summary.total === 0) {
    return "revoked";
  }

  if (input.summary.pending === 0 && input.summary.failed === 0) {
    return "revoked";
  }

  const hasRunningTask = input.revokeItems.some((item) =>
    item.taskStatus === ACCESS_TASK_STATUS.running || item.taskStatus === ACCESS_TASK_STATUS.retrying
  );

  return hasRunningTask ? "revoking" : "revoke_tasks_created";
}

function isTerminalSuccessfulRevokeItem(item: OffboardingStatusRevokeItem): boolean {
  return item.taskStatus === ACCESS_TASK_STATUS.completed || isCoveredSlackChannelSkippedTask(item);
}

function isCoveredSlackChannelSkippedTask(item: OffboardingStatusRevokeItem): boolean {
  return (
    item.taskStatus === ACCESS_TASK_STATUS.skipped &&
    (
      item.taskErrorMessage === "covered_by_workspace_membership_revoke" ||
      item.taskExternalResultJson?.reason === "covered_by_workspace_membership_revoke"
    )
  );
}

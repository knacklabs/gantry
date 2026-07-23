import { Injectable } from "@nestjs/common";
import {
  ACCESS_TASK_STATUS,
  accessRequests,
  accessResources,
  accessTasks,
  APPROVAL_DECISION,
  approvals,
  auditEvents,
  roles,
  systems
} from "@itops/db";
import { eq } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";
import type { DecideAccessRequestInput } from "./dto/decide-access-request.dto.js";

export type AccessRequest = typeof accessRequests.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type AccessTask = typeof accessTasks.$inferSelect;

export type AccessRequestDecision = {
  accessRequest: AccessRequest;
  approval: Approval;
  accessTask: AccessTask | null;
};

type DecideAccessRequestRepositoryInput = DecideAccessRequestInput & {
  accessRequestId: string;
};

type RecordApprovalDeniedByPolicyInput = {
  accessRequest: AccessRequest;
  approverExternalUserId: string;
  reason: string;
};

export function buildAccessTaskIdempotencyKey(input: {
  action: AccessRequest["action"];
  employeeId: string;
  systemKey: string;
  resourceKey: string;
  roleKey: string;
}): string {
  return [input.action, input.employeeId, input.systemKey, input.resourceKey, input.roleKey].join(":");
}

@Injectable()
export class ApprovalsRepository {
  constructor(private readonly databaseProvider: DatabaseProvider) {}

  async findAccessRequestById(id: string): Promise<AccessRequest | undefined> {
    const [accessRequest] = await this.databaseProvider.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.id, id))
      .limit(1);

    return accessRequest;
  }

  async recordApprovalDeniedByPolicy(input: RecordApprovalDeniedByPolicyInput): Promise<void> {
    await this.databaseProvider.db.insert(auditEvents).values({
      actorExternalUserId: input.approverExternalUserId,
      eventType: "approval.denied_by_policy",
      entityType: "access_request",
      entityId: input.accessRequest.id,
      metadataJson: {
        reason: input.reason,
        requested_by_external_user_id: input.accessRequest.requestedByExternalUserId
      }
    });
  }

  async decideAccessRequest(input: DecideAccessRequestRepositoryInput): Promise<AccessRequestDecision> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const [approval] = await tx
        .insert(approvals)
        .values({
          accessRequestId: input.accessRequestId,
          approverExternalUserId: input.approverExternalUserId,
          decision: input.decision,
          comment: input.comment ?? null,
          source: input.source,
          gantryConversationId: input.gantryConversationId ?? null,
          gantryRuntimeEventId: input.gantryRuntimeEventId ?? null
        })
        .returning();

      const [accessRequest] = await tx
        .update(accessRequests)
        .set({
          status: input.decision,
          updatedAt: new Date()
        })
        .where(eq(accessRequests.id, input.accessRequestId))
        .returning();

      const accessTask =
        input.decision === APPROVAL_DECISION.approved
          ? await this.createOrFindAccessTask(tx, {
              accessRequest,
              actorExternalUserId: input.approverExternalUserId
            })
          : null;

      await tx.insert(auditEvents).values({
        actorExternalUserId: input.approverExternalUserId,
        eventType: input.decision === APPROVAL_DECISION.approved ? "approval.approved" : "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        afterJson: approval,
        metadataJson: {
          access_request_id: input.accessRequestId
        }
      });

      return {
        accessRequest,
        approval,
        accessTask
      };
    });
  }

  private async createOrFindAccessTask(
    tx: Parameters<Parameters<DatabaseProvider["db"]["transaction"]>[0]>[0],
    input: {
      accessRequest: AccessRequest;
      actorExternalUserId: string;
    }
  ): Promise<AccessTask> {
    const [taskContext] = await tx
      .select({
        systemKey: systems.key,
        resourceKey: accessResources.key,
        roleKey: roles.key
      })
      .from(accessRequests)
      .innerJoin(systems, eq(accessRequests.systemId, systems.id))
      .innerJoin(accessResources, eq(accessRequests.resourceId, accessResources.id))
      .innerJoin(roles, eq(accessRequests.roleId, roles.id))
      .where(eq(accessRequests.id, input.accessRequest.id))
      .limit(1);

    if (!taskContext) {
      throw new Error("Access request task context was not found.");
    }

    const idempotencyKey = buildAccessTaskIdempotencyKey({
      action: input.accessRequest.action,
      employeeId: input.accessRequest.employeeId,
      systemKey: taskContext.systemKey,
      resourceKey: taskContext.resourceKey,
      roleKey: taskContext.roleKey
    });

    const [createdTask] = await tx
      .insert(accessTasks)
      .values({
        accessRequestId: input.accessRequest.id,
        operation: input.accessRequest.action,
        connector: taskContext.systemKey,
        status: ACCESS_TASK_STATUS.pendingManual,
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
}

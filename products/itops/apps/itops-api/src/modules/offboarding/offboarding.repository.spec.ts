import {
  ACCESS_GRANT_STATUS,
  ACCESS_TASK_STATUS,
  accessGrants,
  accessTasks,
  auditEvents,
  employees,
  EMPLOYEE_STATUS,
  OFFBOARDING_INTAKE_STATUS,
  OFFBOARDING_REVOKE_ITEM_STATUS,
  offboardingIntakes,
  offboardingRevokeItems,
  ROLE_RISK_LEVEL
} from "@itops/db";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseProvider } from "../../database/database.provider.js";
import { OffboardingRepository, type Employee, type OffboardingIntake } from "./offboarding.repository.js";

describe("OffboardingRepository", () => {
  it("creates an offboarding intake and audit event in one transaction", async () => {
    const offboardingIntake = makeOffboardingIntake();
    const intakeReturning = {
      returning: vi.fn(async () => [offboardingIntake])
    };
    const intakeValues = {
      values: vi.fn(() => intakeReturning)
    };
    const auditValues = vi.fn(async () => undefined);
    const tx = {
      insert: vi.fn((table) => {
        if (table === offboardingIntakes) {
          return intakeValues;
        }

        if (table === auditEvents) {
          return {
            values: auditValues
          };
        }

        throw new Error("Unexpected table insert.");
      })
    };
    const databaseProvider = {
      db: {
        transaction: vi.fn(async (callback) => callback(tx))
      }
    };
    const repository = new OffboardingRepository(databaseProvider as unknown as DatabaseProvider);

    await expect(
      repository.createOffboardingIntake({
        employeeId: offboardingIntake.employeeId,
        requestedByExternalUserId: "slack:U123",
        reason: "Resignation",
        lastWorkingDay: "2026-06-30",
        notes: "Offboarding requested from Slack",
        activeAccessCount: 3,
        employeeStatusAtCreation: EMPLOYEE_STATUS.active
      })
    ).resolves.toEqual(offboardingIntake);

    expect(intakeValues.values).toHaveBeenCalledWith({
      employeeId: offboardingIntake.employeeId,
      requestedByExternalUserId: "slack:U123",
      reason: "Resignation",
      lastWorkingDay: "2026-06-30",
      notes: "Offboarding requested from Slack",
      status: OFFBOARDING_INTAKE_STATUS.waitingForReview
    });
    expect(auditValues).toHaveBeenCalledWith({
      actorExternalUserId: "slack:U123",
      eventType: "offboarding_intake.created",
      entityType: "offboarding_intake",
      entityId: offboardingIntake.id,
      afterJson: offboardingIntake,
      metadataJson: {
        employee_id: offboardingIntake.employeeId,
        activeAccessCount: 3,
        employee_status_at_creation: EMPLOYEE_STATUS.active
      }
    });
  });

  it("finalizes offboarding and writes audit events in one transaction", async () => {
    const offboardingIntake = makeOffboardingIntake({ status: OFFBOARDING_INTAKE_STATUS.inProgress });
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const finalizedIntake = {
      ...offboardingIntake,
      status: OFFBOARDING_INTAKE_STATUS.completed,
      completedAt: new Date("2026-06-02T00:00:00.000Z")
    };
    const finalizedEmployee = {
      ...employee,
      status: EMPLOYEE_STATUS.offboarded,
      endDate: "2026-06-30"
    };
    const statusRows = [makeStatusRow({
      grantStatus: ACCESS_GRANT_STATUS.revoked,
      taskStatus: ACCESS_TASK_STATUS.completed
    })];
    const finalizedStatusRows = [makeStatusRow({
      grantStatus: ACCESS_GRANT_STATUS.revoked,
      taskStatus: ACCESS_TASK_STATUS.completed,
      revokeItemStatus: OFFBOARDING_REVOKE_ITEM_STATUS.completed
    })];
    const selectRows = vi.fn()
      .mockResolvedValueOnce(statusRows)
      .mockResolvedValueOnce(finalizedStatusRows);
    const selectChain = makeSelectChain(selectRows);
    const intakeReturning = vi.fn(async () => [finalizedIntake]);
    const employeeReturning = vi.fn(async () => [finalizedEmployee]);
    const revokeItemsWhere = vi.fn(async () => undefined);
    const auditValues = vi.fn(async () => undefined);
    const tx = {
      select: vi.fn(() => selectChain),
      update: vi.fn((table) => {
        if (table === offboardingIntakes) {
          return makeUpdateReturningChain(intakeReturning);
        }

        if (table === employees) {
          return makeUpdateReturningChain(employeeReturning);
        }

        if (table === offboardingRevokeItems) {
          return {
            set: vi.fn(() => ({
              where: revokeItemsWhere
            }))
          };
        }

        throw new Error("Unexpected table update.");
      }),
      insert: vi.fn((table) => {
        if (table === auditEvents) {
          return {
            values: auditValues
          };
        }

        throw new Error("Unexpected table insert.");
      })
    };
    const databaseProvider = {
      db: {
        select: vi.fn(() => makeSelectChain(vi.fn(async () => []))),
        transaction: vi.fn(async (callback) => callback(tx))
      }
    };
    const repository = new OffboardingRepository(databaseProvider as unknown as DatabaseProvider);

    await expect(repository.finalizeOffboarding({
      offboardingIntake,
      employee
    })).resolves.toMatchObject({
      offboardingIntake: finalizedIntake,
      employee: finalizedEmployee,
      summary: {
        total: 1,
        completed: 1,
        pending: 0,
        failed: 0
      },
      canFinalize: true
    });

    expect(intakeReturning).toHaveBeenCalled();
    expect(employeeReturning).toHaveBeenCalled();
    expect(revokeItemsWhere).toHaveBeenCalled();
    expect(auditValues).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        eventType: "offboarding.completed",
        entityType: "offboarding_intake",
        entityId: offboardingIntake.id
      }),
      expect.objectContaining({
        eventType: "employee.offboarded",
        entityType: "employee",
        entityId: employee.id
      })
    ]));
  });

  it("records denied offboarding transitions with safe metadata", async () => {
    const offboardingIntake = makeOffboardingIntake({ status: OFFBOARDING_INTAKE_STATUS.waitingForReview });
    const auditValues = vi.fn(async () => undefined);
    const databaseProvider = {
      db: {
        insert: vi.fn((table) => {
          if (table === auditEvents) {
            return {
              values: auditValues
            };
          }

          throw new Error("Unexpected table insert.");
        })
      }
    };
    const repository = new OffboardingRepository(databaseProvider as unknown as DatabaseProvider);

    await repository.recordOffboardingTransitionDenied({
      offboardingIntake,
      actorExternalUserId: "slack:U_APPROVER",
      attemptedAction: "execute_revoke_task",
      currentState: "waiting_for_approval",
      reason: "waiting_for_approval"
    });

    expect(auditValues).toHaveBeenCalledWith({
      actorExternalUserId: "slack:U_APPROVER",
      eventType: "offboarding.transition_denied",
      entityType: "offboarding_intake",
      entityId: offboardingIntake.id,
      metadataJson: {
        attempted_action: "execute_revoke_task",
        current_state: "waiting_for_approval",
        reason: "waiting_for_approval",
        employee_id: offboardingIntake.employeeId
      }
    });
  });

  it("derives failed workflow state from failed revoke task status", async () => {
    const offboardingIntake = makeOffboardingIntake({ status: OFFBOARDING_INTAKE_STATUS.inProgress });
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.offboarding });
    const selectRows = vi.fn()
      .mockResolvedValueOnce([makeStatusRow({
        grantStatus: ACCESS_GRANT_STATUS.active,
        taskStatus: ACCESS_TASK_STATUS.failed
      })])
      .mockResolvedValueOnce([]);
    const databaseProvider = {
      db: {
        select: vi.fn(() => makeSelectChain(selectRows))
      }
    };
    const repository = new OffboardingRepository(databaseProvider as unknown as DatabaseProvider);

    await expect(repository.getOffboardingStatus({
      offboardingIntake,
      employee
    })).resolves.toMatchObject({
      workflowState: "failed",
      canFinalize: false,
      summary: {
        failed: 1
      }
    });
  });
});

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

function makeStatusRow(overrides: {
  grantStatus?: string;
  taskStatus?: string;
  revokeItemStatus?: string;
} = {}) {
  return {
    revokeItem: {
      id: "33e8b54b-3f65-4f29-9312-7c02892dc8cb",
      accessGrantId: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
      accessRequestId: "0ab14c88-6f22-484b-ad51-65d89d6adbbf",
      accessTaskId: "e149bb10-5628-45e7-b59c-07199a76b10a",
      status: overrides.revokeItemStatus ?? OFFBOARDING_REVOKE_ITEM_STATUS.taskCreated,
      errorMessage: null
    },
    grant: {
      status: overrides.grantStatus ?? ACCESS_GRANT_STATUS.active
    },
    accessTask: {
      id: "e149bb10-5628-45e7-b59c-07199a76b10a",
      status: overrides.taskStatus ?? ACCESS_TASK_STATUS.pending,
      errorMessage: null,
      externalResultJson: null
    },
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
    }
  };
}

function makeSelectChain(rows: ReturnType<typeof vi.fn>) {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: rows,
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => rows().then(resolve, reject)
  };

  return chain;
}

function makeUpdateReturningChain(returning: ReturnType<typeof vi.fn>) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning
      }))
    }))
  };
}

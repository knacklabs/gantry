import {
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_STATUS,
  ACCESS_RESOURCE_TYPE,
  ACCESS_RESOURCE_KEY,
  ACCESS_GRANT_STATUS,
  ACCESS_TASK_STATUS,
  accessRequests,
  accessResources,
  auditEvents,
  EMPLOYEE_STATUS,
  employees,
  ONBOARDING_INTAKE_STATUS,
  onboardingIntakes,
  ROLE_KEY,
  roles,
  ROLE_RISK_LEVEL,
  slackSourceMessages,
  SYSTEM_KEY,
  SYSTEM_STATUS,
  systems
} from "@itops/db";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseProvider } from "../../database/database.provider.js";
import {
  type AccessRequest,
  type Employee,
  getRequiredOnboardingSetupCompleteness,
  getInitialOnboardingAccessTaskStatus,
  OnboardingRepository,
  type OnboardingIntake,
  type OnboardingSetupItem,
  type SlackSourceMessage
} from "./onboarding.repository.js";

describe("OnboardingRepository", () => {
  it("creates an onboarding intake and audit event in one transaction", async () => {
    const sourceMessage = makeSourceMessage();
    const updatedSourceMessage = makeSourceMessage({ detectedType: "new_joiner_alert" });
    const onboardingIntake = makeOnboardingIntake();
    const sourceReturning = {
      returning: vi.fn(async () => [updatedSourceMessage])
    };
    const sourceWhere = {
      where: vi.fn(() => sourceReturning)
    };
    const sourceSet = {
      set: vi.fn(() => sourceWhere)
    };
    const intakeReturning = {
      returning: vi.fn(async () => [onboardingIntake])
    };
    const intakeValues = {
      values: vi.fn(() => intakeReturning)
    };
    const auditValues = vi.fn(async () => undefined);
    const tx = {
      update: vi.fn((table) => {
        expect(table).toBe(slackSourceMessages);
        return sourceSet;
      }),
      insert: vi.fn((table) => {
        if (table === onboardingIntakes) {
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
    const repository = new OnboardingRepository(databaseProvider as unknown as DatabaseProvider, "manual");

    await expect(
      repository.createOnboardingIntake({
        sourceMessage,
        actorExternalUserId: "slack:U123",
        parsedFields: {
          name: "Riya Sharma",
          personalEmail: "riya.personal@example.com",
          contactNo: "+91 9876543210",
          doj: "2026-07-01",
          employmentType: "fte",
          designation: "Backend Engineer",
          laptop: "MacBook Pro",
          relocation: "No",
          slackChannels: ["backend-alerts"]
        },
        validation: {
          valid: true,
          normalized: {
            name: "Riya Sharma",
            personalEmail: "riya.personal@example.com",
            contactNo: "+91 9876543210",
            doj: "2026-07-01",
            employmentType: "fte",
            designation: "Backend Engineer",
            laptop: "MacBook Pro",
            relocation: "No",
            slackChannels: ["backend-alerts"]
          },
          validationErrors: []
        }
      })
    ).resolves.toEqual({
      sourceMessage: updatedSourceMessage,
      onboardingIntake
    });

    expect(sourceSet.set).toHaveBeenCalledWith(expect.objectContaining({
      detectedType: "new_joiner_alert"
    }));
    expect(intakeValues.values).toHaveBeenCalledWith(expect.objectContaining({
      sourceMessageId: sourceMessage.id,
      personalEmail: "riya.personal@example.com",
      status: ONBOARDING_INTAKE_STATUS.waitingForReview
    }));
    expect(auditValues).toHaveBeenCalledWith({
      actorExternalUserId: "slack:U123",
      eventType: "onboarding_intake.created",
      entityType: "onboarding_intake",
      entityId: onboardingIntake.id,
      afterJson: onboardingIntake,
      metadataJson: {
        source_message_id: updatedSourceMessage.id
      }
    });
  });

  it("creates an employee, updates the intake, and writes onboarding employee audit", async () => {
    const onboardingIntake = makeOnboardingIntake();
    const employee = makeEmployee();
    const updatedIntake = makeOnboardingIntake({
      employeeId: employee.id,
      status: ONBOARDING_INTAKE_STATUS.approved
    });
    const employeeReturning = {
      returning: vi.fn(async () => [employee])
    };
    const employeeValues = {
      values: vi.fn(() => employeeReturning)
    };
    const intakeReturning = {
      returning: vi.fn(async () => [updatedIntake])
    };
    const intakeWhere = {
      where: vi.fn(() => intakeReturning)
    };
    const intakeSet = {
      set: vi.fn(() => intakeWhere)
    };
    const auditValues = vi.fn(async () => undefined);
    const tx = {
      insert: vi.fn((table) => {
        if (table === employees) {
          return employeeValues;
        }

        if (table === auditEvents) {
          return {
            values: auditValues
          };
        }

        throw new Error("Unexpected table insert.");
      }),
      update: vi.fn((table) => {
        expect(table).toBe(onboardingIntakes);
        return intakeSet;
      })
    };
    const databaseProvider = {
      db: {
        transaction: vi.fn(async (callback) => callback(tx))
      }
    };
    const repository = new OnboardingRepository(databaseProvider as unknown as DatabaseProvider, "manual");

    await expect(
      repository.createEmployeeForOnboarding({
        onboardingIntake,
        actorExternalUserId: "slack:U123"
      })
    ).resolves.toEqual({
      employee,
      onboardingIntake: updatedIntake
    });

    expect(employeeValues.values).toHaveBeenCalledWith(expect.objectContaining({
      fullName: "Riya Sharma",
      personalEmail: "riya.personal@example.com",
      workEmail: null,
      contactNo: "+91 9876543210",
      status: EMPLOYEE_STATUS.preboarding
    }));
    expect(intakeSet.set).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: employee.id,
      status: ONBOARDING_INTAKE_STATUS.approved
    }));
    expect(auditValues).toHaveBeenCalledWith({
      actorExternalUserId: "slack:U123",
      eventType: "onboarding.employee_created",
      entityType: "onboarding_intake",
      entityId: updatedIntake.id,
      afterJson: updatedIntake,
      metadataJson: {
        employee_id: employee.id
      }
    });
  });

  it("creates Google Workspace email access request, updates intake, and writes audit", async () => {
    const employee = makeEmployee();
    const onboardingIntake = makeOnboardingIntake({ employeeId: employee.id });
    const accessRequest = makeAccessRequest({ employeeId: employee.id });
    const updatedIntake = makeOnboardingIntake({
      employeeId: employee.id,
      googleWorkspaceAccessRequestId: accessRequest.id,
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning
    });
    const system = {
      id: accessRequest.systemId,
      key: SYSTEM_KEY.googleWorkspace,
      name: "Google Workspace",
      status: "active",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    };
    const resource = {
      id: accessRequest.resourceId,
      systemId: system.id,
      key: ACCESS_RESOURCE_KEY.companyEmail,
      name: "Company Email",
      resourceType: "account",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    };
    const role = {
      id: accessRequest.roleId,
      systemId: system.id,
      key: ROLE_KEY.user,
      name: "User",
      riskLevel: "medium",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    };
    const selectLimit = vi
      .fn()
      .mockResolvedValueOnce([system])
      .mockResolvedValueOnce([resource])
      .mockResolvedValueOnce([role]);
    const selectWhere = {
      where: vi.fn(() => ({
        limit: selectLimit
      }))
    };
    const selectFrom = {
      from: vi.fn(() => selectWhere)
    };
    const accessRequestReturning = {
      returning: vi.fn(async () => [accessRequest])
    };
    const accessRequestValues = {
      values: vi.fn(() => accessRequestReturning)
    };
    const intakeReturning = {
      returning: vi.fn(async () => [updatedIntake])
    };
    const intakeWhere = {
      where: vi.fn(() => intakeReturning)
    };
    const intakeSet = {
      set: vi.fn(() => intakeWhere)
    };
    const auditValues = vi.fn(async () => undefined);
    const tx = {
      select: vi.fn(() => selectFrom),
      insert: vi.fn((table) => {
        if (table === accessRequests) {
          return accessRequestValues;
        }

        if (table === auditEvents) {
          return {
            values: auditValues
          };
        }

        throw new Error("Unexpected table insert.");
      }),
      update: vi.fn((table) => {
        expect(table).toBe(onboardingIntakes);
        return intakeSet;
      })
    };
    const databaseProvider = {
      db: {
        transaction: vi.fn(async (callback) => callback(tx))
      }
    };
    const repository = new OnboardingRepository(databaseProvider as unknown as DatabaseProvider, "manual");

    await expect(
      repository.createGoogleWorkspaceAccessRequestForOnboarding({
        onboardingIntake,
        employee,
        actorExternalUserId: "slack:U123"
      })
    ).resolves.toEqual({
      onboardingIntake: updatedIntake,
      accessRequest
    });

    expect(selectFrom.from).toHaveBeenNthCalledWith(1, systems);
    expect(selectFrom.from).toHaveBeenNthCalledWith(2, accessResources);
    expect(selectFrom.from).toHaveBeenNthCalledWith(3, roles);
    expect(accessRequestValues.values).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: employee.id,
      action: ACCESS_REQUEST_ACTION.grant,
      status: ACCESS_REQUEST_STATUS.waitingForApproval,
      reason: "Company email required for onboarding",
      requestedByExternalUserId: "slack:U123",
      requestedFrom: "onboarding_intake"
    }));
    expect(intakeSet.set).toHaveBeenCalledWith(expect.objectContaining({
      googleWorkspaceAccessRequestId: accessRequest.id,
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning
    }));
    expect(auditValues).toHaveBeenCalledWith({
      actorExternalUserId: "slack:U123",
      eventType: "onboarding.google_workspace_email_requested",
      entityType: "onboarding_intake",
      entityId: updatedIntake.id,
      afterJson: updatedIntake,
      metadataJson: {
        employee_id: employee.id,
        access_request_id: accessRequest.id
      }
    });
  });

  it("finds or creates a normalized Slack channel resource", async () => {
    const system = {
      id: "83de87a1-b08a-4e52-9f1c-871443819ca2",
      key: SYSTEM_KEY.slack,
      name: "Slack",
      status: SYSTEM_STATUS.active,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    };
    const role = {
      id: "6552245d-0228-457d-8c4b-5abec37d748e",
      systemId: system.id,
      key: ROLE_KEY.member,
      name: "Member",
      riskLevel: ROLE_RISK_LEVEL.low,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    };
    const resource = {
      id: "ad4bf7ef-3cfd-4e07-9d09-59a0e9377d47",
      systemId: system.id,
      key: "backend-alerts",
      name: "#backend-alerts",
      resourceType: ACCESS_RESOURCE_TYPE.channel,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    };
    const selectLimit = vi.fn().mockResolvedValueOnce([system]).mockResolvedValueOnce([role]);
    const selectWhere = {
      where: vi.fn(() => ({
        limit: selectLimit
      }))
    };
    const selectFrom = {
      from: vi.fn(() => selectWhere)
    };
    const resourceReturning = {
      returning: vi.fn(async () => [resource])
    };
    const resourceConflict = {
      onConflictDoUpdate: vi.fn(() => resourceReturning)
    };
    const resourceValues = {
      values: vi.fn(() => resourceConflict)
    };
    const tx = {
      select: vi.fn(() => selectFrom),
      insert: vi.fn((table) => {
        expect(table).toBe(accessResources);
        return resourceValues;
      })
    };
    const databaseProvider = {
      db: {
        transaction: vi.fn(async (callback) => callback(tx))
      }
    };
    const repository = new OnboardingRepository(databaseProvider as unknown as DatabaseProvider, "manual");

    await expect(repository.findOrCreateSlackChannelResource("  #Backend-Alerts  ")).resolves.toEqual(resource);

    expect(selectFrom.from).toHaveBeenNthCalledWith(1, systems);
    expect(selectFrom.from).toHaveBeenNthCalledWith(2, roles);
    expect(resourceValues.values).toHaveBeenCalledWith({
      systemId: system.id,
      key: "backend-alerts",
      name: "#backend-alerts",
      resourceType: ACCESS_RESOURCE_TYPE.channel
    });
    expect(resourceConflict.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: [accessResources.systemId, accessResources.key],
      set: expect.objectContaining({
        name: "#backend-alerts",
        resourceType: ACCESS_RESOURCE_TYPE.channel
      })
    }));
  });

  it("creates executable Slack workspace tasks when browser invite mode is enabled", () => {
    expect(getInitialOnboardingAccessTaskStatus({
      systemKey: SYSTEM_KEY.slack,
      resourceKey: ACCESS_RESOURCE_KEY.workspaceMembership,
      resourceType: ACCESS_RESOURCE_TYPE.workspace
    }, "browser")).toBe(ACCESS_TASK_STATUS.pending);
  });

  it("keeps Slack workspace tasks manual when invite mode is manual", () => {
    expect(getInitialOnboardingAccessTaskStatus({
      systemKey: SYSTEM_KEY.slack,
      resourceKey: ACCESS_RESOURCE_KEY.workspaceMembership,
      resourceType: ACCESS_RESOURCE_TYPE.workspace
    }, "manual")).toBe(ACCESS_TASK_STATUS.pendingManual);
  });

  it("creates Slack channel tasks as dependency-blocked until workspace membership is active", () => {
    expect(getInitialOnboardingAccessTaskStatus({
      systemKey: SYSTEM_KEY.slack,
      resourceKey: "backend-alerts",
      resourceType: ACCESS_RESOURCE_TYPE.channel
    }, "browser")).toBe(ACCESS_TASK_STATUS.pendingDependency);
  });

  it("requires Slack workspace membership but not Slack channel tasks for onboarding finalization", () => {
    const completeness = getRequiredOnboardingSetupCompleteness(makeOnboardingIntake({
      requestedSlackChannels: ["general"]
    }), [
      makeOnboardingSetupItem(),
      makeOnboardingSetupItem({
        system: {
          key: SYSTEM_KEY.slack,
          name: "Slack"
        },
        resource: {
          key: ACCESS_RESOURCE_KEY.workspaceMembership,
          name: "Workspace Membership",
          resourceType: ACCESS_RESOURCE_TYPE.workspace
        },
        taskStatus: ACCESS_TASK_STATUS.completed,
        grantStatus: ACCESS_GRANT_STATUS.active
      }),
      makeOnboardingSetupItem({
        system: {
          key: SYSTEM_KEY.slack,
          name: "Slack"
        },
        resource: {
          key: "general",
          name: "#general",
          resourceType: ACCESS_RESOURCE_TYPE.channel
        },
        taskStatus: ACCESS_TASK_STATUS.pendingDependency,
        grantStatus: null
      })
    ]);

    expect(completeness.missingRequiredCount).toBe(0);
    expect(completeness.requiredItems).toHaveLength(2);
    expect(completeness.requiredItems.some((item) => item.resource.resourceType === ACCESS_RESOURCE_TYPE.channel)).toBe(false);
  });

  it("requires Slack workspace membership even when no Slack channels were requested", () => {
    const completeness = getRequiredOnboardingSetupCompleteness(makeOnboardingIntake({
      requestedSlackChannels: []
    }), [
      makeOnboardingSetupItem()
    ]);

    expect(completeness.missingRequiredCount).toBe(1);
    expect(completeness.requiredItems).toHaveLength(1);
    expect(completeness.requiredItems[0]?.system.key).toBe(SYSTEM_KEY.googleWorkspace);
  });

  it("creates Google Workspace onboarding tasks as executable", () => {
    expect(getInitialOnboardingAccessTaskStatus({
      systemKey: SYSTEM_KEY.googleWorkspace,
      resourceKey: ACCESS_RESOURCE_KEY.companyEmail,
      resourceType: ACCESS_RESOURCE_TYPE.account
    }, "manual")).toBe(ACCESS_TASK_STATUS.pending);
  });
});

function makeSourceMessage(overrides: Partial<SlackSourceMessage> = {}): SlackSourceMessage {
  return {
    id: "36efa7e4-e73b-4414-8d56-9e2a5c72c6fb",
    provider: "slack",
    workspaceId: "T123",
    channelId: "C123",
    messageTs: "1710000000.000000",
    threadTs: "1710000000.000000",
    senderExternalUserId: "slack:U123",
    rawText: "New Joiner Alert\nName: Riya Sharma",
    detectedType: "unknown",
    processedStatus: "received",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeOnboardingIntake(overrides: Partial<OnboardingIntake> = {}): OnboardingIntake {
  return {
    id: "08eebdd5-c91d-4ef0-8927-89346898ca19",
    sourceMessageId: "36efa7e4-e73b-4414-8d56-9e2a5c72c6fb",
    employeeId: null,
    googleWorkspaceAccessRequestId: null,
    name: "Riya Sharma",
    personalEmail: "riya.personal@example.com",
    contactNo: "+91 9876543210",
    doj: "2026-07-01",
    employmentType: "fte",
    designation: "Backend Engineer",
    laptop: "MacBook Pro",
    relocation: "No",
    requestedSlackChannels: ["backend-alerts"],
    validationErrors: [],
    status: ONBOARDING_INTAKE_STATUS.received,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "cc9e59fa-2e04-4317-b2ab-35438461b888",
    fullName: "Riya Sharma",
    workEmail: null,
    personalEmail: "riya.personal@example.com",
    contactNo: "+91 9876543210",
    employmentType: "fte",
    designation: "Backend Engineer",
    department: null,
    status: EMPLOYEE_STATUS.preboarding,
    startDate: "2026-07-01",
    endDate: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeOnboardingSetupItem(overrides: Partial<OnboardingSetupItem> = {}): OnboardingSetupItem {
  return {
    accessRequestId: "7a49574e-287c-4d2b-9583-14a4a425df5d",
    accessTaskId: "fb65e3ec-9c15-44ce-92f9-b318c741be38",
    system: {
      key: SYSTEM_KEY.googleWorkspace,
      name: "Google Workspace"
    },
    resource: {
      key: ACCESS_RESOURCE_KEY.companyEmail,
      name: "Company Email",
      resourceType: ACCESS_RESOURCE_TYPE.account
    },
    role: {
      key: ROLE_KEY.user,
      name: "User"
    },
    requestStatus: ACCESS_REQUEST_STATUS.completed,
    taskStatus: ACCESS_TASK_STATUS.completed,
    taskErrorMessage: null,
    grantStatus: ACCESS_GRANT_STATUS.active,
    required: true,
    ...overrides
  };
}

function makeAccessRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: "7a49574e-287c-4d2b-9583-14a4a425df5d",
    employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888",
    systemId: "4d4659d9-5f9a-4ffb-9d8e-d35715ed4f9d",
    resourceId: "fc475b10-4b1f-4685-8a50-a4bd898eac2f",
    roleId: "51f04689-d1c5-4185-a6ce-d418c1ad323f",
    action: ACCESS_REQUEST_ACTION.grant,
    status: ACCESS_REQUEST_STATUS.waitingForApproval,
    reason: "Company email required for onboarding",
    requestedByExternalUserId: "slack:U123",
    requestedFrom: "onboarding_intake",
    sourceConversationId: null,
    sourceMessageId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

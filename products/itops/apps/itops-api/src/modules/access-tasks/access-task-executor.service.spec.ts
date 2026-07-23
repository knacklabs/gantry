import { BadGatewayException, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { SlackBrowserLoginMode, SlackWorkspaceInviteMode } from "@itops/config";
import {
  GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE,
  GOOGLE_WORKSPACE_PROVIDER,
  GoogleWorkspaceConnectorError,
  SLACK_PROVIDER,
  SLACK_CONNECTOR_ERROR_CODE,
  SlackConnectorError,
  type GoogleWorkspaceConnectorInterface,
  type SlackBrowserInviteConnector,
  type SlackBrowserLoginConnector,
  type SlackBrowserWorkspaceRevokeConnector,
  type SlackConnectorInterface,
  type SlackWorkspaceInviteConnectorInterface
} from "@itops/connectors";
import {
  ACCESS_GRANT_STATUS,
  ACCESS_RESOURCE_KEY,
  ACCESS_RESOURCE_TYPE,
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_STATUS,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_STATUS,
  AUDIT_ACTOR,
  EMPLOYEE_STATUS,
  OFFBOARDING_INTAKE_STATUS,
  ROLE_KEY,
  ROLE_RISK_LEVEL,
  SYSTEM_KEY,
  SYSTEM_STATUS
} from "@itops/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailGeneratorService } from "../google-workspace/email-generator.service.js";
import type { EmailService } from "../email/email.service.js";
import {
  AccessTaskExecutorService
} from "./access-task-executor.service.js";
import {
  AccessTasksRepository,
  type AccessGrant,
  type AccessTask,
  type AccessTaskExecutionContext,
  type MockCompleteAccessTaskResult
} from "./access-tasks.repository.js";

type AccessTasksRepositoryMock = {
  findExecutionContextByTaskId: ReturnType<typeof vi.fn>;
  findGrantForAccessRequest: ReturnType<typeof vi.fn>;
  isWorkEmailTaken: ReturnType<typeof vi.fn>;
  hasActiveSlackWorkspaceMembershipGrant: ReturnType<typeof vi.fn>;
  hasRevokedSlackWorkspaceMembershipGrant: ReturnType<typeof vi.fn>;
  markAccessTaskRunning: ReturnType<typeof vi.fn>;
  markAccessTaskFailed: ReturnType<typeof vi.fn>;
  markAccessTaskPendingDependency: ReturnType<typeof vi.fn>;
  markAccessTaskRetrying: ReturnType<typeof vi.fn>;
  completeExecutedAccessTask: ReturnType<typeof vi.fn>;
  completeConnectorAccessTask: ReturnType<typeof vi.fn>;
  completeRevokeAccessTask: ReturnType<typeof vi.fn>;
  completeSlackChannelRevokeAccessTask: ReturnType<typeof vi.fn>;
  completeSlackChannelRevokeCoveredByWorkspaceTask: ReturnType<typeof vi.fn>;
  completeSlackWorkspaceMembershipRevokeAccessTask: ReturnType<typeof vi.fn>;
  findOffboardingIntakeForAccessTask: ReturnType<typeof vi.fn>;
  recordOffboardingTransitionDenied: ReturnType<typeof vi.fn>;
  finalizeRelatedLifecycleForTerminalAccessTask: ReturnType<typeof vi.fn>;
};

type EmailServiceMock = {
  sendGoogleWorkspaceWelcomeEmail: ReturnType<typeof vi.fn>;
};

describe("AccessTaskExecutorService", () => {
  let repository: AccessTasksRepositoryMock;
  let emailGeneratorService: EmailGeneratorService;
  let emailService: EmailServiceMock;
  let googleWorkspaceConnector: GoogleWorkspaceConnectorInterface;
  let slackConnector: SlackConnectorInterface;
  let slackWorkspaceInviteConnector: SlackWorkspaceInviteConnectorInterface;
  let slackBrowserInviteConnector: Pick<SlackBrowserInviteConnector, "inviteUserToWorkspace">;
  let slackBrowserWorkspaceRevokeConnector: Pick<
    SlackBrowserWorkspaceRevokeConnector,
    "revokeUserFromWorkspace" | "activateUserInWorkspace"
  >;
  let slackBrowserLoginConnector: Pick<SlackBrowserLoginConnector, "login">;
  let service: AccessTaskExecutorService;

  beforeEach(() => {
    repository = {
      findExecutionContextByTaskId: vi.fn(),
      findGrantForAccessRequest: vi.fn(),
      isWorkEmailTaken: vi.fn(),
      hasActiveSlackWorkspaceMembershipGrant: vi.fn(async () => true),
      hasRevokedSlackWorkspaceMembershipGrant: vi.fn(async () => false),
      markAccessTaskRunning: vi.fn(),
      markAccessTaskFailed: vi.fn(),
      markAccessTaskPendingDependency: vi.fn(),
      markAccessTaskRetrying: vi.fn(),
      completeExecutedAccessTask: vi.fn(),
      completeConnectorAccessTask: vi.fn(),
      completeRevokeAccessTask: vi.fn(),
      completeSlackChannelRevokeAccessTask: vi.fn(),
      completeSlackChannelRevokeCoveredByWorkspaceTask: vi.fn(),
      completeSlackWorkspaceMembershipRevokeAccessTask: vi.fn(),
      findOffboardingIntakeForAccessTask: vi.fn(),
      recordOffboardingTransitionDenied: vi.fn(),
      finalizeRelatedLifecycleForTerminalAccessTask: vi.fn()
    };
    emailGeneratorService = new EmailGeneratorService();
    emailService = {
      sendGoogleWorkspaceWelcomeEmail: vi.fn(async () => ({
        status: "sent",
        emailMessageId: "9a2aa346-016e-4482-8847-01a70deeed13"
      }))
    };
    googleWorkspaceConnector = {
      createUser: vi.fn(async (input) => ({
        provider: GOOGLE_WORKSPACE_PROVIDER,
        externalUserId: `mock-google-workspace:${input.primaryEmail}`,
        primaryEmail: input.primaryEmail,
        created: true,
        alreadyExisted: false,
        temporaryPassword: "temp-password-123"
      })),
      getUserByEmail: vi.fn(),
      suspendUser: vi.fn()
    };
    slackConnector = {
      lookupUserByEmail: vi.fn(),
      findChannelByName: vi.fn(),
      findChannelById: vi.fn(),
      isUserInChannel: vi.fn(),
      addUserToChannel: vi.fn(async (input) => ({
        provider: SLACK_PROVIDER,
        userId: `mock-slack-user:${input.userEmail.trim().toLowerCase()}`,
        userEmail: input.userEmail.trim().toLowerCase(),
        channelId: `mock-slack-channel:${input.channelName.trim().replace(/^#+/u, "").toLowerCase()}`,
        channelName: input.channelName.trim().replace(/^#+/u, "").toLowerCase(),
        added: true,
        alreadyInChannel: false
      })),
      removeUserFromChannel: vi.fn(async (input) => ({
        provider: SLACK_PROVIDER,
        operation: "remove_user_from_channel" as const,
        userId: `mock-slack-user:${input.userEmail.trim().toLowerCase()}`,
        userEmail: input.userEmail.trim().toLowerCase(),
        channelId: `mock-slack-channel:${input.channelName.trim().replace(/^#+/u, "").toLowerCase()}`,
        channelName: input.channelName.trim().replace(/^#+/u, "").toLowerCase(),
        removed: true,
        alreadyRemoved: false
      }))
    };
    slackWorkspaceInviteConnector = {
      inviteUserToWorkspace: vi.fn(async (input) => ({
        provider: SLACK_PROVIDER,
        email: input.email.trim().toLowerCase(),
        invited: true,
        alreadyInWorkspace: false,
        alreadyInvited: false,
        userId: `mock-slack-user:${input.email.trim().toLowerCase()}`,
        channelIds: input.channelIds ?? []
      }))
    };
    slackBrowserInviteConnector = {
      inviteUserToWorkspace: vi.fn(async (input) => ({
        provider: SLACK_PROVIDER,
        mode: "browser" as const,
        email: input.email.trim().toLowerCase(),
        inviteSubmitted: true,
        dryRun: false,
        message: "Slack browser invite was submitted."
      }))
    };
    slackBrowserWorkspaceRevokeConnector = {
      revokeUserFromWorkspace: vi.fn(async (input) => ({
        provider: SLACK_PROVIDER,
        mode: "browser" as const,
        operation: "workspace_revoke" as const,
        email: input.email.trim().toLowerCase(),
        revoked: true,
        alreadyInactive: false,
        dryRun: false,
        message: "Slack workspace member was deactivated."
      })),
      activateUserInWorkspace: vi.fn(async (input) => ({
        provider: SLACK_PROVIDER,
        mode: "browser" as const,
        operation: "workspace_activate" as const,
        email: input.email.trim().toLowerCase(),
        activated: true,
        alreadyActive: false,
        notFound: false,
        dryRun: false,
        message: "Slack workspace member was activated."
      }))
    };
    slackBrowserLoginConnector = {
      login: vi.fn(async () => ({
        provider: SLACK_PROVIDER,
        mode: "browser" as const,
        loginMode: "google_sso" as const,
        authenticated: true,
        loginRecovered: true,
        message: "Slack browser profile was authenticated with Google SSO."
      }))
    };

    service = makeService("automated");
  });

  function makeService(
    slackWorkspaceInviteMode: SlackWorkspaceInviteMode,
    slackBrowserLoginMode: SlackBrowserLoginMode = "manual"
  ): AccessTaskExecutorService {
    return new AccessTaskExecutorService(
      repository as unknown as AccessTasksRepository,
      emailGeneratorService,
      emailService as unknown as EmailService,
      googleWorkspaceConnector,
      "company.com",
      slackConnector,
      slackWorkspaceInviteConnector,
      slackBrowserInviteConnector,
      slackBrowserWorkspaceRevokeConnector,
      slackWorkspaceInviteMode,
      slackBrowserLoginConnector,
      slackBrowserLoginMode,
      "https://example.slack.com"
    );
  }

  it("executes a pending Google Workspace company email grant task", async () => {
    const context = makeExecutionContext();
    const completedResult = makeExecutionResult();

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.isWorkEmailTaken.mockResolvedValue(false);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({ status: ACCESS_TASK_STATUS.running }));
    repository.completeExecutedAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(repository.finalizeRelatedLifecycleForTerminalAccessTask).toHaveBeenCalledWith({ context });
    expect(repository.markAccessTaskRunning).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system
    });
    expect(googleWorkspaceConnector.createUser).toHaveBeenCalledWith({
      primaryEmail: "riya.sharma@company.com",
      fullName: "Riya Sharma",
      givenName: "Riya",
      familyName: "Sharma",
      personalEmail: "riya.personal@example.com"
    });
    expect(repository.completeExecutedAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      primaryEmail: "riya.sharma@company.com",
      connectorResult: {
        provider: SYSTEM_KEY.googleWorkspace,
        externalUserId: "mock-google-workspace:riya.sharma@company.com",
        primaryEmail: "riya.sharma@company.com",
        created: true,
        alreadyExisted: false
      }
    });
    expect(emailService.sendGoogleWorkspaceWelcomeEmail).toHaveBeenCalledWith({
      employeeId: context.employee.id,
      accessTaskId: completedResult.task.id,
      employeeFullName: "Riya Sharma",
      personalEmail: "riya.personal@example.com",
      workEmail: "riya.sharma@company.com",
      temporaryPassword: "temp-password-123"
    });
  });

  it("blocks offboarding revoke task execution before intake approval and audits the denial", async () => {
    const baseContext = makeGoogleWorkspaceRevokeExecutionContext();
    const context = makeGoogleWorkspaceRevokeExecutionContext({
      accessRequest: {
        ...baseContext.accessRequest,
        requestedFrom: "offboarding_intake"
      }
    });
    const offboardingIntake = {
      id: "7c644f93-056a-40bf-815a-9512e050aab5",
      employeeId: context.employee.id,
      requestedByExternalUserId: "slack:U123",
      reason: "Resignation",
      lastWorkingDay: "2026-06-30",
      notes: null,
      status: OFFBOARDING_INTAKE_STATUS.waitingForReview,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      approvedAt: null,
      rejectedAt: null,
      completedAt: null
    };

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.findOffboardingIntakeForAccessTask.mockResolvedValue(offboardingIntake);

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(ConflictException);

    expect(repository.recordOffboardingTransitionDenied).toHaveBeenCalledWith({
      offboardingIntake,
      actorExternalUserId: AUDIT_ACTOR.system,
      attemptedAction: "execute_revoke_task",
      currentState: "waiting_for_approval",
      reason: "waiting_for_approval",
      accessTaskId: context.task.id
    });
    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(googleWorkspaceConnector.suspendUser).not.toHaveBeenCalled();
  });

  it("executes a pending Slack channel member grant task with the mock connector contract", async () => {
    const context = makeSlackExecutionContext();
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "mock-slack-user:riya.personal@example.com:mock-slack-channel:backend-alerts"
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(repository.markAccessTaskRunning).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system
    });
    expect(slackConnector.addUserToChannel).toHaveBeenCalledWith({
      userEmail: "riya.personal@example.com",
      channelName: "backend-alerts"
    });
    expect(repository.completeConnectorAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      externalAccountId: "mock-slack-user:riya.personal@example.com:mock-slack-channel:backend-alerts",
      connectorResult: {
        provider: SLACK_PROVIDER,
        userId: "mock-slack-user:riya.personal@example.com",
        userEmail: "riya.personal@example.com",
        channelId: "mock-slack-channel:backend-alerts",
        channelName: "backend-alerts",
        added: true,
        alreadyInChannel: false
      }
    });
    expect(repository.completeExecutedAccessTask).not.toHaveBeenCalled();
  });

  it("executes a pending Google Workspace company email revoke task", async () => {
    const context = makeGoogleWorkspaceRevokeExecutionContext();
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        operation: ACCESS_TASK_OPERATION.revoke,
        status: ACCESS_TASK_STATUS.completed,
        idempotencyKey: "revoke:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:google_workspace:company_email:user"
      }),
      grant: makeAccessGrant({
        status: ACCESS_GRANT_STATUS.revoked,
        revokedAt: new Date("2026-06-02T00:00:00.000Z")
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      operation: ACCESS_TASK_OPERATION.revoke,
      status: ACCESS_TASK_STATUS.running
    }));
    vi.mocked(googleWorkspaceConnector.suspendUser).mockResolvedValue({
      provider: GOOGLE_WORKSPACE_PROVIDER,
      externalUserId: "mock-google-workspace:riya.sharma@company.com",
      primaryEmail: "riya.sharma@company.com",
      suspended: true,
      alreadySuspended: false,
      alreadyMissing: false
    });
    repository.completeRevokeAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(repository.markAccessTaskRunning).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system
    });
    expect(googleWorkspaceConnector.suspendUser).toHaveBeenCalledWith({
      primaryEmail: "riya.sharma@company.com"
    });
    expect(repository.completeRevokeAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      connectorResult: {
        provider: GOOGLE_WORKSPACE_PROVIDER,
        externalUserId: "mock-google-workspace:riya.sharma@company.com",
        primaryEmail: "riya.sharma@company.com",
        suspended: true,
        alreadySuspended: false,
        alreadyMissing: false
      }
    });
    expect(repository.completeExecutedAccessTask).not.toHaveBeenCalled();
  });

  it("executes a pending Slack channel member revoke task with the Slack API connector", async () => {
    const context = makeSlackExecutionContext({
      task: makeAccessTask({
        operation: ACCESS_TASK_OPERATION.revoke,
        connector: SYSTEM_KEY.slack,
        idempotencyKey: "revoke:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:backend-alerts:member"
      }),
      accessRequest: {
        ...makeExecutionContext().accessRequest,
        action: ACCESS_REQUEST_ACTION.revoke,
        status: ACCESS_REQUEST_STATUS.approved
      }
    });
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        operation: ACCESS_TASK_OPERATION.revoke,
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        status: ACCESS_GRANT_STATUS.revoked,
        revokedAt: new Date("2026-06-02T00:00:00.000Z")
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      operation: ACCESS_TASK_OPERATION.revoke,
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    repository.completeSlackChannelRevokeAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackConnector.removeUserFromChannel).toHaveBeenCalledWith({
      userEmail: "riya.personal@example.com",
      channelName: "backend-alerts"
    });
    expect(repository.completeSlackChannelRevokeAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      connectorResult: {
        provider: SLACK_PROVIDER,
        operation: "remove_user_from_channel",
        userId: "mock-slack-user:riya.personal@example.com",
        userEmail: "riya.personal@example.com",
        channelId: "mock-slack-channel:backend-alerts",
        channelName: "backend-alerts",
        removed: true,
        alreadyRemoved: false
      }
    });
  });

  it("executes a pending Slack workspace membership revoke task with browser automation", async () => {
    service = makeService("browser");
    const context = makeSlackWorkspaceMembershipExecutionContext({
      task: makeAccessTask({
        operation: ACCESS_TASK_OPERATION.revoke,
        connector: SYSTEM_KEY.slack,
        idempotencyKey: "revoke:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:workspace_membership:member"
      }),
      accessRequest: {
        ...makeExecutionContext().accessRequest,
        action: ACCESS_REQUEST_ACTION.revoke,
        status: ACCESS_REQUEST_STATUS.approved
      }
    });
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        operation: ACCESS_TASK_OPERATION.revoke,
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        status: ACCESS_GRANT_STATUS.revoked,
        revokedAt: new Date("2026-06-02T00:00:00.000Z")
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.completeSlackWorkspaceMembershipRevokeAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackBrowserWorkspaceRevokeConnector.revokeUserFromWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com"
    });
    expect(repository.completeSlackWorkspaceMembershipRevokeAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      connectorResult: {
        provider: SLACK_PROVIDER,
        mode: "browser",
        operation: "workspace_revoke",
        email: "riya.personal@example.com",
        revoked: true,
        alreadyInactive: false,
        dryRun: false,
        message: "Slack workspace member was deactivated."
      }
    });
  });

  it("allows failed Slack workspace membership revoke tasks to execute again", async () => {
    service = makeService("browser");
    const context = makeSlackWorkspaceMembershipExecutionContext({
      task: makeAccessTask({
        operation: ACCESS_TASK_OPERATION.revoke,
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.failed,
        idempotencyKey: "revoke:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:workspace_membership:member"
      }),
      accessRequest: {
        ...makeExecutionContext().accessRequest,
        action: ACCESS_REQUEST_ACTION.revoke,
        status: ACCESS_REQUEST_STATUS.approved
      }
    });
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        operation: ACCESS_TASK_OPERATION.revoke,
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        status: ACCESS_GRANT_STATUS.revoked,
        revokedAt: new Date("2026-06-02T00:00:00.000Z")
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.completeSlackWorkspaceMembershipRevokeAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackBrowserWorkspaceRevokeConnector.revokeUserFromWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com"
    });
    expect(repository.completeSlackWorkspaceMembershipRevokeAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      connectorResult: {
        provider: SLACK_PROVIDER,
        mode: "browser",
        operation: "workspace_revoke",
        email: "riya.personal@example.com",
        revoked: true,
        alreadyInactive: false,
        dryRun: false,
        message: "Slack workspace member was deactivated."
      }
    });
  });

  it("completes Google Workspace revoke when the Google user is already missing", async () => {
    const context = makeGoogleWorkspaceRevokeExecutionContext();
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        operation: ACCESS_TASK_OPERATION.revoke,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        status: ACCESS_GRANT_STATUS.revoked,
        revokedAt: new Date("2026-06-02T00:00:00.000Z")
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      operation: ACCESS_TASK_OPERATION.revoke,
      status: ACCESS_TASK_STATUS.running
    }));
    vi.mocked(googleWorkspaceConnector.suspendUser).mockResolvedValue({
      provider: GOOGLE_WORKSPACE_PROVIDER,
      externalUserId: "missing:riya.sharma@company.com",
      primaryEmail: "riya.sharma@company.com",
      suspended: true,
      alreadyMissing: true
    });
    repository.completeRevokeAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(repository.completeRevokeAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      connectorResult: {
        provider: GOOGLE_WORKSPACE_PROVIDER,
        externalUserId: "missing:riya.sharma@company.com",
        primaryEmail: "riya.sharma@company.com",
        suspended: true,
        alreadyMissing: true
      }
    });
  });

  it("marks a Google Workspace revoke task failed when work email is missing", async () => {
    const context = makeGoogleWorkspaceRevokeExecutionContext({
      employee: {
        ...makeExecutionContext().employee,
        workEmail: null
      }
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.markAccessTaskFailed).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Employee work_email is required to execute Google Workspace revocation tasks.",
      externalResultJson: {
        provider: SYSTEM_KEY.googleWorkspace,
        ok: false,
        code: "google_workspace_email_missing",
        message: "Employee work_email is required to execute Google Workspace revocation tasks."
      }
    });
    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(googleWorkspaceConnector.suspendUser).not.toHaveBeenCalled();
    expect(repository.completeRevokeAccessTask).not.toHaveBeenCalled();
  });

  it("marks a Slack channel task pending_dependency when workspace membership is not active", async () => {
    const context = makeSlackExecutionContext();
    const pendingDependencyTask = makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.pendingDependency,
      errorMessage: "Slack workspace membership is required before channel access",
      externalResultJson: {
        code: "slack_workspace_membership_required",
        requiredResource: ACCESS_RESOURCE_KEY.workspaceMembership
      }
    });
    const dependencyResult = {
      task: pendingDependencyTask,
      grant: null,
      dependencyRequired: true as const,
      code: "slack_workspace_membership_required" as const
    };

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.hasActiveSlackWorkspaceMembershipGrant.mockResolvedValue(false);
    repository.markAccessTaskPendingDependency.mockResolvedValue(dependencyResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toEqual(dependencyResult);

    expect(repository.hasActiveSlackWorkspaceMembershipGrant).toHaveBeenCalledWith(context.employee.id);
    expect(repository.markAccessTaskPendingDependency).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Slack workspace membership is required before channel access",
      externalResultJson: {
        code: "slack_workspace_membership_required",
        requiredResource: ACCESS_RESOURCE_KEY.workspaceMembership
      },
      code: "slack_workspace_membership_required"
    });
    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(slackConnector.addUserToChannel).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("executes a Slack workspace membership grant task when invite automation is enabled", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "mock-slack-user:riya.personal@example.com"
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackWorkspaceInviteConnector.inviteUserToWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com",
      fullName: "Riya Sharma"
    });
    expect(repository.completeConnectorAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      externalAccountId: "mock-slack-user:riya.personal@example.com",
      connectorResult: {
        provider: SLACK_PROVIDER,
        email: "riya.personal@example.com",
        invited: true,
        alreadyInWorkspace: false,
        alreadyInvited: false,
        userId: "mock-slack-user:riya.personal@example.com",
        channelIds: []
      }
    });
    expect(slackConnector.addUserToChannel).not.toHaveBeenCalled();
  });

  it("returns a task-only manual response for Slack workspace membership when invite mode is manual", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    service = makeService("manual");

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).resolves.toEqual({
      task: context.task,
      grant: null,
      code: "slack_workspace_invite_manual",
      message: "Slack workspace invite is manual"
    });

    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(slackWorkspaceInviteConnector.inviteUserToWorkspace).not.toHaveBeenCalled();
    expect(slackBrowserInviteConnector.inviteUserToWorkspace).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("marks a Slack workspace membership task failed when admin invite scope is missing", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    vi.mocked(slackWorkspaceInviteConnector.inviteUserToWorkspace).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.missingScope,
      message: "Slack admin token is missing a required scope.",
      details: {
        needed: "admin.users:write"
      }
    }));

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadGatewayException);

    expect(repository.markAccessTaskFailed).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Slack admin token is missing a required scope.",
      externalResultJson: {
        provider: SLACK_PROVIDER,
        ok: false,
        code: SLACK_CONNECTOR_ERROR_CODE.missingScope,
        message: "Slack admin token is missing a required scope.",
        details: {
          needed: "admin.users:write"
        }
      }
    });
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("returns a task-only dry-run result for Slack browser workspace invite", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    service = makeService("browser");
    vi.mocked(slackBrowserInviteConnector.inviteUserToWorkspace).mockResolvedValue({
      provider: SLACK_PROVIDER,
      mode: "browser",
      email: "riya.personal@example.com",
      inviteSubmitted: false,
      dryRun: true,
      message: "Slack browser invite dry run reached the invite UI without submitting."
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).resolves.toEqual({
      task: context.task,
      grant: null,
      code: "slack_browser_invite_dry_run",
      message: "Slack browser invite dry run reached the invite UI without submitting.",
      connectorResult: {
        provider: SLACK_PROVIDER,
        mode: "browser",
        inviteSubmitted: false,
        dryRun: true,
        email: "riya.personal@example.com",
        message: "Slack browser invite dry run reached the invite UI without submitting.",
        membershipPolicy: "invite_sent_treated_as_active"
      }
    });

    expect(slackBrowserInviteConnector.inviteUserToWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com",
      fullName: "Riya Sharma"
    });
    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("completes Slack workspace membership when browser invite is submitted live", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "invite_sent:riya.personal@example.com"
      })
    });
    service = makeService("browser");

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(slackBrowserInviteConnector.inviteUserToWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com",
      fullName: "Riya Sharma"
    });
    expect(repository.completeConnectorAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      externalAccountId: "invite_sent:riya.personal@example.com",
      connectorResult: {
        provider: SLACK_PROVIDER,
        mode: "browser",
        inviteSubmitted: true,
        dryRun: false,
        email: "riya.personal@example.com",
        message: "Slack browser invite was submitted.",
        membershipPolicy: "invite_sent_treated_as_active"
      },
      auditEvents: [
        {
          eventType: "slack.workspace_invite.sent",
          entityType: "access_task",
          entityId: context.task.id,
          afterJson: {
            provider: SLACK_PROVIDER,
            mode: "browser",
            inviteSubmitted: true,
            dryRun: false,
            email: "riya.personal@example.com",
            message: "Slack browser invite was submitted.",
            membershipPolicy: "invite_sent_treated_as_active"
          },
          metadataJson: {
            access_request_id: context.accessRequest.id,
            employee_id: context.employee.id,
            email: "riya.personal@example.com"
          }
        }
      ]
    });
    expect(slackConnector.addUserToChannel).not.toHaveBeenCalled();
  });

  it("reactivates Slack workspace membership instead of inviting when a revoked workspace grant exists", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "slack-workspace:riya.personal@example.com"
      })
    });
    service = makeService("browser");

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.hasRevokedSlackWorkspaceMembershipGrant.mockResolvedValue(true);
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackBrowserWorkspaceRevokeConnector.activateUserInWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com"
    });
    expect(slackBrowserInviteConnector.inviteUserToWorkspace).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      externalAccountId: "slack-workspace:riya.personal@example.com",
      connectorResult: {
        provider: SLACK_PROVIDER,
        mode: "browser",
        operation: "workspace_activate",
        email: "riya.personal@example.com",
        activated: true,
        alreadyActive: false,
        notFound: false,
        dryRun: false,
        message: "Slack workspace member was activated."
      },
      auditEvents: [
        {
          eventType: "slack.workspace_membership.activated",
          entityType: "access_task",
          entityId: context.task.id,
          afterJson: {
            provider: SLACK_PROVIDER,
            mode: "browser",
            operation: "workspace_activate",
            email: "riya.personal@example.com",
            activated: true,
            alreadyActive: false,
            notFound: false,
            dryRun: false,
            message: "Slack workspace member was activated."
          },
          metadataJson: {
            access_request_id: context.accessRequest.id,
            employee_id: context.employee.id,
            email: "riya.personal@example.com",
            alreadyActive: false
          }
        }
      ]
    });
  });

  it("falls back to Slack browser invite when activation cannot find the revoked member", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "invite_sent:riya.personal@example.com"
      })
    });
    service = makeService("browser");

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.hasRevokedSlackWorkspaceMembershipGrant.mockResolvedValue(true);
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);
    vi.mocked(slackBrowserWorkspaceRevokeConnector.activateUserInWorkspace).mockResolvedValue({
      provider: SLACK_PROVIDER,
      mode: "browser",
      operation: "workspace_activate",
      email: "riya.personal@example.com",
      activated: false,
      alreadyActive: false,
      notFound: true,
      dryRun: false,
      message: "Slack workspace member was not found."
    });

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackBrowserWorkspaceRevokeConnector.activateUserInWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com"
    });
    expect(slackBrowserInviteConnector.inviteUserToWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com",
      fullName: "Riya Sharma"
    });
  });

  it("allows retrying Slack browser workspace invite tasks to execute again", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.retrying,
        idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:workspace_membership:member"
      })
    });
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "invite_sent:riya.personal@example.com"
      })
    });
    service = makeService("browser");

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackBrowserInviteConnector.inviteUserToWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com",
      fullName: "Riya Sharma"
    });
    expect(repository.completeConnectorAccessTask).toHaveBeenCalled();
  });

  it("allows failed Slack browser workspace invite tasks to execute again", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.failed,
        idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:workspace_membership:member"
      })
    });
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "invite_sent:riya.personal@example.com"
      })
    });
    service = makeService("browser");

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackBrowserInviteConnector.inviteUserToWorkspace).toHaveBeenCalledWith({
      email: "riya.personal@example.com",
      fullName: "Riya Sharma"
    });
    expect(repository.completeConnectorAccessTask).toHaveBeenCalled();
  });

  it("fails Slack browser workspace invite when live connector does not submit an invite", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    service = makeService("browser");
    vi.mocked(slackBrowserInviteConnector.inviteUserToWorkspace).mockResolvedValue({
      provider: SLACK_PROVIDER,
      mode: "browser",
      email: "riya.personal@example.com",
      inviteSubmitted: false,
      dryRun: false,
      message: "Slack browser invite did not submit."
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadGatewayException);

    expect(repository.markAccessTaskFailed).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Slack browser invite did not submit the workspace invite.",
      externalResultJson: {
        provider: SLACK_PROVIDER,
        mode: "browser",
        inviteSubmitted: false,
        dryRun: false,
        email: "riya.personal@example.com",
        message: "Slack browser invite did not submit the workspace invite.",
        membershipPolicy: "invite_sent_treated_as_active",
        ok: false,
        code: SLACK_CONNECTOR_ERROR_CODE.browserInviteFailed
      }
    });
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("does not fail or complete the task when Slack browser profile is not logged in and browser login mode is manual", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    service = makeService("browser", "manual");
    vi.mocked(slackBrowserInviteConnector.inviteUserToWorkspace).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
      message: "Slack browser profile is not logged in."
    }));

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(repository.markAccessTaskFailed).not.toHaveBeenCalled();
    expect(slackBrowserLoginConnector.login).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("recovers Slack browser login with Google SSO and retries the workspace invite once", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "invite_sent:riya.personal@example.com"
      })
    });
    service = makeService("browser", "google_sso");
    vi.mocked(slackBrowserInviteConnector.inviteUserToWorkspace)
      .mockRejectedValueOnce(new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        message: "Slack browser profile is not logged in."
      }))
      .mockResolvedValueOnce({
        provider: SLACK_PROVIDER,
        mode: "browser",
        email: "riya.personal@example.com",
        inviteSubmitted: true,
        dryRun: false,
        message: "Slack browser invite was submitted."
      });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackBrowserLoginConnector.login).toHaveBeenCalledOnce();
    expect(slackBrowserInviteConnector.inviteUserToWorkspace).toHaveBeenCalledTimes(2);
    expect(repository.completeConnectorAccessTask).toHaveBeenCalledWith({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      externalAccountId: "invite_sent:riya.personal@example.com",
      connectorResult: {
        provider: SLACK_PROVIDER,
        mode: "browser",
        inviteSubmitted: true,
        dryRun: false,
        email: "riya.personal@example.com",
        message: "Slack browser invite was submitted.",
        loginRecovered: true,
        retryAfterLogin: true,
        membershipPolicy: "invite_sent_treated_as_active"
      },
      auditEvents: [
        {
          eventType: "slack.browser_login.recovered",
          entityType: "access_task",
          entityId: context.task.id,
          afterJson: {
            provider: SLACK_PROVIDER,
            mode: "browser",
            loginRecovered: true
          },
          metadataJson: {
            access_request_id: context.accessRequest.id,
            employee_id: context.employee.id
          }
        },
        {
          eventType: "slack.workspace_invite.sent",
          entityType: "access_task",
          entityId: context.task.id,
          afterJson: {
            provider: SLACK_PROVIDER,
            mode: "browser",
            inviteSubmitted: true,
            dryRun: false,
            email: "riya.personal@example.com",
            message: "Slack browser invite was submitted.",
            loginRecovered: true,
            retryAfterLogin: true,
            membershipPolicy: "invite_sent_treated_as_active"
          },
          metadataJson: {
            access_request_id: context.accessRequest.id,
            employee_id: context.employee.id,
            email: "riya.personal@example.com"
          }
        }
      ]
    });
  });

  it("does not create a grant when Slack browser Google SSO recovery needs MFA", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    service = makeService("browser", "google_sso");
    vi.mocked(slackBrowserInviteConnector.inviteUserToWorkspace).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
      message: "Slack browser profile is not logged in."
    }));
    vi.mocked(slackBrowserLoginConnector.login).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired,
      message: "Slack browser Google SSO login requires MFA."
    }));

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadRequestException);

    expect(slackBrowserLoginConnector.login).toHaveBeenCalledOnce();
    expect(slackBrowserInviteConnector.inviteUserToWorkspace).toHaveBeenCalledTimes(1);
    expect(repository.markAccessTaskFailed).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("marks Slack browser invite timeout retrying without creating an active grant", async () => {
    const context = makeSlackWorkspaceMembershipExecutionContext();
    service = makeService("browser");
    vi.mocked(slackBrowserInviteConnector.inviteUserToWorkspace).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserTimeout,
      message: "Slack browser invite timed out.",
      statusCode: 429
    }));

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).rejects.toMatchObject({
      status: 429
    });

    expect(repository.markAccessTaskRetrying).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Slack browser invite timed out. The access task will be retried.",
      externalResultJson: {
        provider: SLACK_PROVIDER,
        ok: false,
        code: SLACK_CONNECTOR_ERROR_CODE.browserTimeout,
        message: "Slack browser invite timed out. The access task will be retried.",
        statusCode: 429,
        details: undefined
      }
    });
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("returns completed task result idempotently", async () => {
    const context = makeExecutionContext({
      task: makeAccessTask({ status: ACCESS_TASK_STATUS.completed })
    });
    const grant = makeAccessGrant();

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.findGrantForAccessRequest.mockResolvedValue(grant);

    await expect(service.executeAccessTask(context.task.id)).resolves.toEqual({
      task: context.task,
      grant
    });

    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(googleWorkspaceConnector.createUser).not.toHaveBeenCalled();
    expect(slackConnector.addUserToChannel).not.toHaveBeenCalled();
    expect(repository.completeExecutedAccessTask).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
    expect(repository.completeRevokeAccessTask).not.toHaveBeenCalled();
    expect(repository.finalizeRelatedLifecycleForTerminalAccessTask).toHaveBeenCalledWith({ context });
  });

  it("returns not found for malformed and missing task ids", async () => {
    await expect(service.executeAccessTask("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findExecutionContextByTaskId).not.toHaveBeenCalled();

    repository.findExecutionContextByTaskId.mockResolvedValue(undefined);

    await expect(service.executeAccessTask("a7f679c4-16eb-40cc-8b16-d45f86717000")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("returns bad request for unsupported task shapes", async () => {
    repository.findExecutionContextByTaskId.mockResolvedValue(
      makeExecutionContext({
        resource: {
          ...makeExecutionContext().resource,
          key: "drive"
        }
      })
    );

    await expect(service.executeAccessTask("a7f679c4-16eb-40cc-8b16-d45f86717bd7")).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
  });

  it("returns bad request for unsupported revoke task shapes", async () => {
    repository.findExecutionContextByTaskId.mockResolvedValue(
      makeGoogleWorkspaceRevokeExecutionContext({
        system: {
          ...makeExecutionContext().system,
          key: SYSTEM_KEY.slack,
          name: "Slack"
        },
        task: makeAccessTask({
          operation: ACCESS_TASK_OPERATION.revoke,
          connector: SYSTEM_KEY.slack
        })
      })
    );

    await expect(service.executeAccessTask("a7f679c4-16eb-40cc-8b16-d45f86717bd7")).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(repository.completeRevokeAccessTask).not.toHaveBeenCalled();
  });

  it("does not execute failed non-Slack-workspace tasks", async () => {
    const context = makeExecutionContext({
      task: makeAccessTask({ status: ACCESS_TASK_STATUS.failed })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(googleWorkspaceConnector.createUser).not.toHaveBeenCalled();
    expect(repository.completeExecutedAccessTask).not.toHaveBeenCalled();
  });

  it("returns bad request when Google Workspace domain is missing", async () => {
    service = new AccessTaskExecutorService(
      repository as unknown as AccessTasksRepository,
      emailGeneratorService,
      emailService as unknown as EmailService,
      googleWorkspaceConnector,
      undefined,
      slackConnector,
      slackWorkspaceInviteConnector,
      slackBrowserInviteConnector,
      slackBrowserWorkspaceRevokeConnector,
      "automated",
      slackBrowserLoginConnector,
      "manual",
      "https://example.slack.com"
    );
    repository.findExecutionContextByTaskId.mockResolvedValue(makeExecutionContext());

    await expect(service.executeAccessTask("a7f679c4-16eb-40cc-8b16-d45f86717bd7")).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
  });

  it("uses a suffixed generated email when the local email is already taken", async () => {
    const context = makeExecutionContext();
    const takenEmails = new Set(["riya.sharma@company.com"]);
    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.isWorkEmailTaken.mockImplementation(async (email: string) => takenEmails.has(email));
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({ status: ACCESS_TASK_STATUS.running }));
    repository.completeExecutedAccessTask.mockResolvedValue(makeExecutionResult());

    await service.executeAccessTask(context.task.id);

    expect(googleWorkspaceConnector.createUser).toHaveBeenCalledWith(expect.objectContaining({
      primaryEmail: "riya.sharma2@company.com"
    }));
  });

  it("marks the task failed when the connector fails", async () => {
    const context = makeExecutionContext();
    const connectorError = new GoogleWorkspaceConnectorError({
      code: GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.permissionDenied,
      message: "Google Workspace permission denied.",
      statusCode: 403,
      details: {
        status: "PERMISSION_DENIED"
      }
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.isWorkEmailTaken.mockResolvedValue(false);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({ status: ACCESS_TASK_STATUS.running }));
    vi.mocked(googleWorkspaceConnector.createUser).mockRejectedValue(connectorError);

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadGatewayException);

    expect(repository.markAccessTaskFailed).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Google Workspace permission denied.",
      externalResultJson: {
        provider: GOOGLE_WORKSPACE_PROVIDER,
        ok: false,
        code: GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.permissionDenied,
        message: "Google Workspace permission denied.",
        statusCode: 403,
        details: {
          status: "PERMISSION_DENIED"
        }
      }
    });
    expect(repository.completeExecutedAccessTask).not.toHaveBeenCalled();
  });

  it("marks a Slack task failed when the employee has no email address", async () => {
    const context = makeSlackExecutionContext({
      employee: {
        ...makeExecutionContext().employee,
        workEmail: null,
        personalEmail: null
      }
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.markAccessTaskFailed).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Employee work_email or personal_email is required to execute Slack channel access tasks.",
      externalResultJson: {
        provider: SYSTEM_KEY.slack,
        ok: false,
        code: "missing_user_email",
        message: "Employee work_email or personal_email is required to execute Slack channel access tasks."
      }
    });
    expect(repository.markAccessTaskRunning).not.toHaveBeenCalled();
    expect(slackConnector.addUserToChannel).not.toHaveBeenCalled();
  });

  it("marks a Slack task failed when the Slack connector fails", async () => {
    const context = makeSlackExecutionContext();

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    vi.mocked(slackConnector.addUserToChannel).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.channelNotFound,
      message: "Slack channel was not found.",
      details: {
        channelName: "backend-alerts"
      }
    }));

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadGatewayException);

    expect(repository.markAccessTaskFailed).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Slack channel was not found.",
      externalResultJson: {
        provider: SLACK_PROVIDER,
        ok: false,
        code: SLACK_CONNECTOR_ERROR_CODE.channelNotFound,
        message: "Slack channel was not found.",
        details: {
          channelName: "backend-alerts"
        }
      }
    });
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("marks a Slack task retrying when Slack user lookup fails after workspace invite", async () => {
    const context = makeSlackExecutionContext();

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    vi.mocked(slackConnector.addUserToChannel).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.userNotFound,
      message: "Slack user was not found.",
      details: {
        userEmail: "riya.personal@example.com"
      }
    }));

    await expect(service.executeAccessTask(context.task.id)).rejects.toMatchObject({
      status: 429
    });

    expect(repository.markAccessTaskRetrying).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Slack user not found yet. Invite may be sent but employee may not have accepted it.",
      externalResultJson: {
        code: "slack_user_not_found_after_invite",
        retryable: true
      }
    });
    expect(repository.markAccessTaskPendingDependency).not.toHaveBeenCalled();
    expect(repository.markAccessTaskFailed).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("executes a retrying Slack channel task once the Slack user exists", async () => {
    const context = makeSlackExecutionContext({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.retrying,
        idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:backend-alerts:member"
      })
    });
    const completedResult = makeExecutionResult({
      task: makeAccessTask({
        connector: SYSTEM_KEY.slack,
        status: ACCESS_TASK_STATUS.completed
      }),
      grant: makeAccessGrant({
        externalAccountId: "mock-slack-user:riya.personal@example.com:mock-slack-channel:backend-alerts"
      })
    });

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    repository.completeConnectorAccessTask.mockResolvedValue(completedResult);

    await expect(service.executeAccessTask(context.task.id)).resolves.toBe(completedResult);

    expect(slackConnector.addUserToChannel).toHaveBeenCalledWith({
      userEmail: "riya.personal@example.com",
      channelName: "backend-alerts"
    });
    expect(repository.completeConnectorAccessTask).toHaveBeenCalled();
    expect(repository.markAccessTaskFailed).not.toHaveBeenCalled();
  });

  it("marks a Slack task failed with a clear message when the bot is not in the channel", async () => {
    const context = makeSlackExecutionContext();

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    vi.mocked(slackConnector.addUserToChannel).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.botNotInChannel,
      message: "Slack bot or caller must be a member of the Slack channel before inviting users."
    }));

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadGatewayException);

    expect(repository.markAccessTaskFailed).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Bot/admin must be added to the channel before inviting users.",
      externalResultJson: {
        provider: SLACK_PROVIDER,
        ok: false,
        code: SLACK_CONNECTOR_ERROR_CODE.botNotInChannel,
        message: "Bot/admin must be added to the channel before inviting users.",
        statusCode: undefined,
        details: undefined
      }
    });
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("marks a Slack task failed with a clear message when Slack scope is missing", async () => {
    const context = makeSlackExecutionContext();

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    vi.mocked(slackConnector.addUserToChannel).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.missingScope,
      message: "Slack token is missing a required scope.",
      details: {
        needed: "channels:write.invites"
      }
    }));

    await expect(service.executeAccessTask(context.task.id)).rejects.toBeInstanceOf(BadGatewayException);

    expect(repository.markAccessTaskFailed).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Slack token is missing a required scope.",
      externalResultJson: {
        provider: SLACK_PROVIDER,
        ok: false,
        code: SLACK_CONNECTOR_ERROR_CODE.missingScope,
        message: "Slack token is missing a required scope.",
        details: {
          needed: "channels:write.invites"
        }
      }
    });
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });

  it("marks a Slack task retrying when Slack rate limits the request", async () => {
    const context = makeSlackExecutionContext();

    repository.findExecutionContextByTaskId.mockResolvedValue(context);
    repository.markAccessTaskRunning.mockResolvedValue(makeAccessTask({
      connector: SYSTEM_KEY.slack,
      status: ACCESS_TASK_STATUS.running
    }));
    vi.mocked(slackConnector.addUserToChannel).mockRejectedValue(new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.rateLimited,
      message: "Slack API rate limit exceeded.",
      statusCode: 429
    }));

    await expect(service.executeAccessTask(context.task.id)).rejects.toMatchObject({
      status: 429
    });

    expect(repository.markAccessTaskRetrying).toHaveBeenCalledWith({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system,
      errorMessage: "Slack API rate limit exceeded. The access task will be retried.",
      externalResultJson: {
        provider: SLACK_PROVIDER,
        ok: false,
        code: SLACK_CONNECTOR_ERROR_CODE.rateLimited,
        message: "Slack API rate limit exceeded. The access task will be retried.",
        statusCode: 429,
        details: undefined
      }
    });
    expect(repository.markAccessTaskFailed).not.toHaveBeenCalled();
    expect(repository.completeConnectorAccessTask).not.toHaveBeenCalled();
  });
});

function makeExecutionContext(overrides: Partial<AccessTaskExecutionContext> = {}): AccessTaskExecutionContext {
  return {
    task: makeAccessTask(),
    accessRequest: {
      id: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
      employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
      systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
      resourceId: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
      roleId: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
      action: ACCESS_REQUEST_ACTION.grant,
      status: ACCESS_REQUEST_STATUS.approved,
      reason: "Create company email during onboarding",
      requestedByExternalUserId: "slack:U123",
      requestedFrom: "api",
      sourceConversationId: null,
      sourceMessageId: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    },
    employee: {
      id: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
      fullName: "Riya Sharma",
      workEmail: null,
      personalEmail: "riya.personal@example.com",
      contactNo: null,
      employmentType: "fte",
      designation: "Backend Engineer",
      department: "Engineering",
      status: EMPLOYEE_STATUS.preboarding,
      startDate: "2026-06-10",
      endDate: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    },
    system: {
      id: "2fef76f2-507f-4c88-babe-07a089fdc003",
      key: SYSTEM_KEY.googleWorkspace,
      name: "Google Workspace",
      status: SYSTEM_STATUS.active,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    },
    resource: {
      id: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
      systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
      key: ACCESS_RESOURCE_KEY.companyEmail,
      name: "Company Email Account",
      resourceType: "account",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    },
    role: {
      id: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
      systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
      key: ROLE_KEY.user,
      name: "User",
      riskLevel: ROLE_RISK_LEVEL.medium,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z")
    },
    ...overrides
  };
}

function makeSlackExecutionContext(overrides: Partial<AccessTaskExecutionContext> = {}): AccessTaskExecutionContext {
  const base = makeExecutionContext();

  return {
    ...base,
    task: makeAccessTask({
      connector: SYSTEM_KEY.slack,
      idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:backend-alerts:member"
    }),
    system: {
      ...base.system,
      key: SYSTEM_KEY.slack,
      name: "Slack"
    },
    resource: {
      ...base.resource,
      key: "backend-alerts",
      name: "#backend-alerts",
      resourceType: ACCESS_RESOURCE_TYPE.channel
    },
    role: {
      ...base.role,
      key: ROLE_KEY.member,
      name: "Member",
      riskLevel: ROLE_RISK_LEVEL.low
    },
    ...overrides
  };
}

function makeGoogleWorkspaceRevokeExecutionContext(
  overrides: Partial<AccessTaskExecutionContext> = {}
): AccessTaskExecutionContext {
  const base = makeExecutionContext();

  return {
    ...base,
    task: makeAccessTask({
      operation: ACCESS_TASK_OPERATION.revoke,
      connector: SYSTEM_KEY.googleWorkspace,
      idempotencyKey: "revoke:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:google_workspace:company_email:user"
    }),
    accessRequest: {
      ...base.accessRequest,
      action: ACCESS_REQUEST_ACTION.revoke,
      status: ACCESS_REQUEST_STATUS.approved,
      reason: "Access revocation required for offboarding"
    },
    employee: {
      ...base.employee,
      workEmail: "riya.sharma@company.com"
    },
    ...overrides
  };
}

function makeSlackWorkspaceMembershipExecutionContext(
  overrides: Partial<AccessTaskExecutionContext> = {}
): AccessTaskExecutionContext {
  const base = makeExecutionContext();

  return {
    ...base,
    task: makeAccessTask({
      connector: SYSTEM_KEY.slack,
      idempotencyKey: "grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:slack:workspace_membership:member"
    }),
    system: {
      ...base.system,
      key: SYSTEM_KEY.slack,
      name: "Slack"
    },
    resource: {
      ...base.resource,
      key: ACCESS_RESOURCE_KEY.workspaceMembership,
      name: "Slack Workspace Membership",
      resourceType: ACCESS_RESOURCE_TYPE.workspace
    },
    role: {
      ...base.role,
      key: ROLE_KEY.member,
      name: "Member",
      riskLevel: ROLE_RISK_LEVEL.low
    },
    ...overrides
  };
}

function makeAccessTask(overrides: Partial<AccessTask> = {}): AccessTask {
  return {
    id: "a7f679c4-16eb-40cc-8b16-d45f86717bd7",
    accessRequestId: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
    operation: ACCESS_TASK_OPERATION.grant,
    connector: SYSTEM_KEY.googleWorkspace,
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

function makeAccessGrant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    id: "54b25d70-3e76-45ee-a1bc-83b982fdd718",
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
    resourceId: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
    roleId: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
    status: ACCESS_GRANT_STATUS.active,
    externalAccountId: "riya.sharma@company.com",
    grantedAt: new Date("2026-06-01T00:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeExecutionResult(overrides: Partial<MockCompleteAccessTaskResult> = {}): MockCompleteAccessTaskResult {
  return {
    task: makeAccessTask({ status: ACCESS_TASK_STATUS.completed }),
    grant: makeAccessGrant(),
    ...overrides
  };
}

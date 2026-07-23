import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { SlackBrowserLoginMode, SlackWorkspaceInviteMode } from "@itops/config";
import {
  GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE,
  normalizeGoogleWorkspaceConnectorError,
  normalizeSlackConnectorError,
  SLACK_CONNECTOR_ERROR_CODE,
  SLACK_PROVIDER,
  SlackConnectorError,
  type GoogleWorkspaceConnectorInterface,
  type CreateGoogleWorkspaceUserResult,
  type SuspendGoogleWorkspaceUserResult,
  type ActivateSlackWorkspaceUserResult,
  type InviteSlackWorkspaceUserResult,
  type SlackBrowserInviteConnector,
  type SlackBrowserLoginConnector,
  type SlackBrowserLoginResult,
  type SlackBrowserWorkspaceRevokeConnector,
  type SlackConnectorInterface,
  type RevokeSlackWorkspaceUserResult,
  type SlackWorkspaceInviteConnectorInterface
} from "@itops/connectors";
import {
  ACCESS_RESOURCE_KEY,
  ACCESS_RESOURCE_TYPE,
  ACCESS_TASK_OPERATION,
  ACCESS_TASK_STATUS,
  AUDIT_ACTOR,
  OFFBOARDING_INTAKE_STATUS,
  ROLE_KEY,
  SYSTEM_KEY
} from "@itops/db";

import { isUuid } from "../../common/validation.js";
import { EmailGeneratorService } from "../google-workspace/email-generator.service.js";
import { EmailService } from "../email/email.service.js";
import {
  AccessTasksRepository,
  type AccessTaskExecutionContext,
  type ExecuteAccessTaskResult,
  type MockCompleteAccessTaskResult
} from "./access-tasks.repository.js";

export const GOOGLE_WORKSPACE_CONNECTOR = Symbol("GOOGLE_WORKSPACE_CONNECTOR");
export const GOOGLE_WORKSPACE_EMAIL_DOMAIN = Symbol("GOOGLE_WORKSPACE_EMAIL_DOMAIN");
export const SLACK_CONNECTOR = Symbol("SLACK_CONNECTOR");
export const SLACK_WORKSPACE_INVITE_CONNECTOR = Symbol("SLACK_WORKSPACE_INVITE_CONNECTOR");
export const SLACK_BROWSER_INVITE_CONNECTOR = Symbol("SLACK_BROWSER_INVITE_CONNECTOR");
export const SLACK_BROWSER_WORKSPACE_REVOKE_CONNECTOR = Symbol("SLACK_BROWSER_WORKSPACE_REVOKE_CONNECTOR");
export const SLACK_BROWSER_LOGIN_CONNECTOR = Symbol("SLACK_BROWSER_LOGIN_CONNECTOR");
export const SLACK_WORKSPACE_INVITE_MODE = Symbol("SLACK_WORKSPACE_INVITE_MODE");
export const SLACK_BROWSER_LOGIN_MODE = Symbol("SLACK_BROWSER_LOGIN_MODE");
export const SLACK_BROWSER_WORKSPACE_URL = Symbol("SLACK_BROWSER_WORKSPACE_URL");

type SlackBrowserInviteConnectorInterface = Pick<SlackBrowserInviteConnector, "inviteUserToWorkspace">;
type SlackBrowserWorkspaceRevokeConnectorInterface = Pick<
  SlackBrowserWorkspaceRevokeConnector,
  "revokeUserFromWorkspace" | "activateUserInWorkspace"
>;
type SlackBrowserLoginConnectorInterface = Pick<SlackBrowserLoginConnector, "login">;

@Injectable()
export class AccessTaskExecutorService {
  constructor(
    private readonly accessTasksRepository: AccessTasksRepository,
    private readonly emailGeneratorService: EmailGeneratorService,
    private readonly emailService: EmailService,
    @Inject(GOOGLE_WORKSPACE_CONNECTOR)
    private readonly googleWorkspaceConnector: GoogleWorkspaceConnectorInterface,
    @Inject(GOOGLE_WORKSPACE_EMAIL_DOMAIN)
    private readonly googleWorkspaceEmailDomain: string | undefined,
    @Inject(SLACK_CONNECTOR)
    private readonly slackConnector: SlackConnectorInterface,
    @Inject(SLACK_WORKSPACE_INVITE_CONNECTOR)
    private readonly slackWorkspaceInviteConnector: SlackWorkspaceInviteConnectorInterface,
    @Inject(SLACK_BROWSER_INVITE_CONNECTOR)
    private readonly slackBrowserInviteConnector: SlackBrowserInviteConnectorInterface,
    @Inject(SLACK_BROWSER_WORKSPACE_REVOKE_CONNECTOR)
    private readonly slackBrowserWorkspaceRevokeConnector: SlackBrowserWorkspaceRevokeConnectorInterface,
    @Inject(SLACK_WORKSPACE_INVITE_MODE)
    private readonly slackWorkspaceInviteMode: SlackWorkspaceInviteMode,
    @Inject(SLACK_BROWSER_LOGIN_CONNECTOR)
    private readonly slackBrowserLoginConnector: SlackBrowserLoginConnectorInterface,
    @Inject(SLACK_BROWSER_LOGIN_MODE)
    private readonly slackBrowserLoginMode: SlackBrowserLoginMode,
    @Inject(SLACK_BROWSER_WORKSPACE_URL)
    private readonly slackBrowserWorkspaceUrl: string | undefined
  ) {}

  async executeAccessTask(id: string): Promise<ExecuteAccessTaskResult> {
    if (!isUuid(id)) {
      throw new NotFoundException("Access task not found.");
    }

    const context = await this.accessTasksRepository.findExecutionContextByTaskId(id);

    if (!context) {
      throw new NotFoundException("Access task not found.");
    }

    if (context.task.status === ACCESS_TASK_STATUS.completed) {
      const grant = await this.accessTasksRepository.findGrantForAccessRequest(context.accessRequest);

      if (!grant) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: "Completed access task does not have an active access grant."
        });
      }

      const result = {
        task: context.task,
        grant
      };

      await this.accessTasksRepository.finalizeRelatedLifecycleForTerminalAccessTask({ context });

      return result;
    }

    await this.assertOffboardingRevokeTaskExecutable(context);

    if (this.isGoogleWorkspaceTask(context)) {
      return this.withRelatedLifecycleFinalization(context, this.executeGoogleWorkspaceTask(context));
    }

    if (this.isGoogleWorkspaceRevokeTask(context)) {
      return this.withRelatedLifecycleFinalization(context, this.executeGoogleWorkspaceRevokeTask(context));
    }

    if (this.isSlackChannelTask(context)) {
      return this.withRelatedLifecycleFinalization(context, this.executeSlackChannelTask(context));
    }

    if (this.isSlackChannelRevokeTask(context)) {
      return this.withRelatedLifecycleFinalization(context, this.executeSlackChannelRevokeTask(context));
    }

    if (this.isSlackWorkspaceMembershipTask(context)) {
      return this.withRelatedLifecycleFinalization(context, this.executeSlackWorkspaceMembershipTask(context));
    }

    if (this.isSlackWorkspaceMembershipRevokeTask(context)) {
      return this.withRelatedLifecycleFinalization(context, this.executeSlackWorkspaceMembershipRevokeTask(context));
    }

    throw new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      message: "Only Google Workspace company_email user tasks and Slack grant/revoke tasks are supported for execution."
    });
  }

  private async withRelatedLifecycleFinalization<T extends ExecuteAccessTaskResult>(
    context: AccessTaskExecutionContext,
    resultPromise: Promise<T>
  ): Promise<T> {
    const result = await resultPromise;

    if (
      result.task.status === ACCESS_TASK_STATUS.completed ||
      result.task.status === ACCESS_TASK_STATUS.skipped
    ) {
      await this.accessTasksRepository.finalizeRelatedLifecycleForTerminalAccessTask({ context });
    }

    return result;
  }

  private async assertOffboardingRevokeTaskExecutable(context: AccessTaskExecutionContext): Promise<void> {
    if (
      context.task.operation !== ACCESS_TASK_OPERATION.revoke ||
      context.accessRequest.requestedFrom !== "offboarding_intake"
    ) {
      return;
    }

    const offboardingIntake = await this.accessTasksRepository.findOffboardingIntakeForAccessTask(context.task.id);

    if (!offboardingIntake) {
      return;
    }

    if (
      offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.approved ||
      offboardingIntake.status === OFFBOARDING_INTAKE_STATUS.inProgress
    ) {
      return;
    }

    const currentState = offboardingExecutionStateForIntakeStatus(offboardingIntake.status);
    const reason = reasonForBlockedOffboardingRevokeExecution(offboardingIntake.status);

    await this.accessTasksRepository.recordOffboardingTransitionDenied({
      offboardingIntake,
      actorExternalUserId: AUDIT_ACTOR.system,
      attemptedAction: "execute_revoke_task",
      currentState,
      reason,
      accessTaskId: context.task.id
    });

    throw new ConflictException({
      statusCode: 409,
      error: "Conflict",
      message: messageForBlockedOffboardingRevokeExecution(offboardingIntake.status),
      reason,
      currentState
    });
  }

  private async executeGoogleWorkspaceTask(context: AccessTaskExecutionContext): Promise<MockCompleteAccessTaskResult> {
    this.assertPendingTask(context);

    if (!this.googleWorkspaceEmailDomain) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "GOOGLE_WORKSPACE_DOMAIN is required to execute Google Workspace access tasks."
      });
    }

    await this.accessTasksRepository.markAccessTaskRunning({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system
    });

    const primaryEmail =
      context.employee.workEmail ??
      (await this.emailGeneratorService.generateCompanyEmail({
        fullName: context.employee.fullName,
        domain: this.googleWorkspaceEmailDomain,
        isEmailTaken: (email) => this.accessTasksRepository.isWorkEmailTaken(email)
      }));

    const nameParts = splitFullName(context.employee.fullName);
    const connectorResult = await this.createGoogleWorkspaceUserOrFailTask(context, {
      primaryEmail,
      fullName: context.employee.fullName,
      givenName: nameParts.givenName,
      familyName: nameParts.familyName,
      personalEmail: context.employee.personalEmail ?? undefined
    });

    const completedResult = await this.accessTasksRepository.completeExecutedAccessTask({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      primaryEmail: connectorResult.primaryEmail,
      connectorResult: sanitizeGoogleWorkspaceConnectorResult(connectorResult)
    });

    await this.sendGoogleWorkspaceWelcomeEmailAfterProvisioning(context, {
      accessTaskId: completedResult.task.id,
      primaryEmail: connectorResult.primaryEmail,
      temporaryPassword: connectorResult.temporaryPassword
    });

    return completedResult;
  }

  private async executeGoogleWorkspaceRevokeTask(
    context: AccessTaskExecutionContext
  ): Promise<MockCompleteAccessTaskResult> {
    this.assertPendingTask(context);

    if (!context.employee.workEmail) {
      const errorMessage = "Employee work_email is required to execute Google Workspace revocation tasks.";

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          provider: SYSTEM_KEY.googleWorkspace,
          ok: false,
          code: "google_workspace_email_missing",
          message: errorMessage
        }
      });

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: errorMessage,
        code: "google_workspace_email_missing"
      });
    }

    await this.accessTasksRepository.markAccessTaskRunning({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system
    });

    const connectorResult = await this.suspendGoogleWorkspaceUserOrFailTask(context, {
      primaryEmail: context.employee.workEmail
    });

    return this.accessTasksRepository.completeRevokeAccessTask({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      connectorResult: sanitizeGoogleWorkspaceSuspendResult(connectorResult)
    });
  }

  private async executeSlackChannelTask(context: AccessTaskExecutionContext): Promise<ExecuteAccessTaskResult> {
    this.assertPendingTask(context);

    // Slack cannot add a user to a channel until the user exists in the workspace.
    // Keep this as a pending dependency so approval is preserved and the task can be retried.
    const hasWorkspaceMembership = await this.accessTasksRepository.hasActiveSlackWorkspaceMembershipGrant(
      context.employee.id
    );

    if (!hasWorkspaceMembership) {
      return this.accessTasksRepository.markAccessTaskPendingDependency({
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
    }

    const userEmail = context.employee.workEmail ?? context.employee.personalEmail;

    if (!userEmail) {
      const errorMessage = "Employee work_email or personal_email is required to execute Slack channel access tasks.";

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          provider: SYSTEM_KEY.slack,
          ok: false,
          code: "missing_user_email",
          message: errorMessage
        }
      });

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: errorMessage,
        code: "missing_user_email"
      });
    }

    const channelName = normalizeSlackChannelName(context.resource.key || context.resource.name);

    if (!channelName) {
      const errorMessage = "Slack channel access resource key or name is required to execute Slack channel access tasks.";

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          provider: SYSTEM_KEY.slack,
          ok: false,
          code: "missing_channel_name",
          message: errorMessage
        }
      });

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: errorMessage,
        code: "missing_channel_name"
      });
    }

    await this.accessTasksRepository.markAccessTaskRunning({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system
    });

    // The external Slack call stays outside repository transactions so DB locks are not held
    // while waiting on Slack network/API behavior.
    const connectorResult = await this.addUserToSlackChannelOrFailTask(context, {
      userEmail,
      channelName
    });

    return this.accessTasksRepository.completeConnectorAccessTask({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      externalAccountId: `${connectorResult.userId}:${connectorResult.channelId}`,
      connectorResult
    });
  }

  private async executeSlackChannelRevokeTask(context: AccessTaskExecutionContext): Promise<ExecuteAccessTaskResult> {
    this.assertPendingTask(context);

    const hasRevokedWorkspaceMembership = await this.accessTasksRepository.hasRevokedSlackWorkspaceMembershipGrant(
      context.employee.id
    );

    if (hasRevokedWorkspaceMembership) {
      return this.accessTasksRepository.completeSlackChannelRevokeCoveredByWorkspaceTask({
        context,
        actorExternalUserId: AUDIT_ACTOR.system,
        connectorResult: {
          provider: SYSTEM_KEY.slack,
          operation: "remove_user_from_channel",
          coveredBy: "workspace_membership_revoke",
          reason: "covered_by_workspace_membership_revoke"
        }
      });
    }

    const userEmail = context.employee.workEmail ?? context.employee.personalEmail;

    if (!userEmail) {
      const errorMessage = "Employee work_email or personal_email is required to execute Slack channel revoke tasks.";

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          provider: SYSTEM_KEY.slack,
          ok: false,
          code: "missing_user_email",
          message: errorMessage
        }
      });

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: errorMessage,
        code: "missing_user_email"
      });
    }

    const channelName = normalizeSlackChannelName(context.resource.key || context.resource.name);

    if (!channelName) {
      const errorMessage = "Slack channel access resource key or name is required to execute Slack channel revoke tasks.";

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          provider: SYSTEM_KEY.slack,
          ok: false,
          code: "missing_channel_name",
          message: errorMessage
        }
      });

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: errorMessage,
        code: "missing_channel_name"
      });
    }

    await this.accessTasksRepository.markAccessTaskRunning({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system
    });

    const connectorResult = await this.removeUserFromSlackChannelOrFailTask(context, {
      userEmail,
      channelName
    });

    return this.accessTasksRepository.completeSlackChannelRevokeAccessTask({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      connectorResult
    });
  }

  private async executeSlackWorkspaceMembershipTask(
    context: AccessTaskExecutionContext
  ): Promise<ExecuteAccessTaskResult> {
    this.assertPendingTask(context, { allowFailedRetry: true });

    // Workspace invite automation uses Slack Admin API and is Enterprise-only; non-Enterprise
    // workspaces should leave it disabled and complete this task manually.
    if (this.slackWorkspaceInviteMode === "manual") {
      return {
        task: context.task,
        grant: null,
        code: "slack_workspace_invite_manual",
        message: "Slack workspace invite is manual"
      };
    }

    const email = context.employee.workEmail ?? context.employee.personalEmail;

    if (!email) {
      const errorMessage = "Employee work_email or personal_email is required to invite a Slack workspace member.";

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          provider: SYSTEM_KEY.slack,
          ok: false,
          code: "missing_user_email",
          message: errorMessage
        }
      });

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: errorMessage,
        code: "missing_user_email"
      });
    }

    if (this.slackWorkspaceInviteMode === "browser") {
      const hasRevokedWorkspaceGrant =
        await this.accessTasksRepository.hasRevokedSlackWorkspaceMembershipGrant(context.employee.id);

      if (hasRevokedWorkspaceGrant) {
        const activationResult = await this.activateSlackWorkspaceMembershipWithBrowserOrFailTask(context, {
          email
        });

        if (activationResult.dryRun) {
          return {
            task: context.task,
            grant: null,
            code: "slack_browser_activate_dry_run",
            message: activationResult.message,
            connectorResult: toSlackBrowserWorkspaceActivateResult(activationResult)
          };
        }

        if (!activationResult.notFound) {
          if (!activationResult.activated) {
            const errorMessage = "Slack browser activate did not activate the workspace member.";
            const connectorResultJson = toSlackBrowserWorkspaceActivateResult(activationResult);

            await this.accessTasksRepository.markAccessTaskFailed({
              taskId: context.task.id,
              accessRequestId: context.accessRequest.id,
              actorExternalUserId: AUDIT_ACTOR.system,
              errorMessage,
              externalResultJson: {
                ...connectorResultJson,
                ok: false,
                code: SLACK_CONNECTOR_ERROR_CODE.browserActivateFailed,
                message: errorMessage
              }
            });

            throw new BadGatewayException({
              statusCode: 502,
              error: "Bad Gateway",
              message: errorMessage,
              code: SLACK_CONNECTOR_ERROR_CODE.browserActivateFailed
            });
          }

          const completionResult = toSlackBrowserWorkspaceActivateResult(activationResult);

          return this.accessTasksRepository.completeConnectorAccessTask({
            context,
            actorExternalUserId: AUDIT_ACTOR.system,
            externalAccountId: `slack-workspace:${completionResult.email}`,
            connectorResult: completionResult,
            auditEvents: [
              ...(completionResult.loginRecovered
                ? [{
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
                  }]
                : []),
              {
                eventType: "slack.workspace_membership.activated",
                entityType: "access_task",
                entityId: context.task.id,
                afterJson: completionResult,
                metadataJson: {
                  access_request_id: context.accessRequest.id,
                  employee_id: context.employee.id,
                  email: completionResult.email,
                  alreadyActive: completionResult.alreadyActive === true
                }
              }
            ]
          });
        }
      }

      const connectorResult = await this.inviteUserToSlackWorkspaceWithBrowserOrFailTask(context, {
        email,
        fullName: context.employee.fullName
      });

      if (connectorResult.dryRun) {
        return {
          task: context.task,
          grant: null,
          code: "slack_browser_invite_dry_run",
          message: connectorResult.message,
          connectorResult: toSlackBrowserWorkspaceInviteResult(connectorResult)
        };
      }

      if (!connectorResult.inviteSubmitted) {
        const errorMessage = "Slack browser invite did not submit the workspace invite.";
        const connectorResultJson = toSlackBrowserWorkspaceInviteResult(connectorResult);

        await this.accessTasksRepository.markAccessTaskFailed({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage,
          externalResultJson: {
            ...connectorResultJson,
            ok: false,
            code: SLACK_CONNECTOR_ERROR_CODE.browserInviteFailed,
            message: errorMessage
          }
        });

        throw new BadGatewayException({
          statusCode: 502,
          error: "Bad Gateway",
          message: errorMessage,
          code: SLACK_CONNECTOR_ERROR_CODE.browserInviteFailed
        });
      }

      const completionResult = toSlackBrowserWorkspaceInviteResult(connectorResult);

      return this.accessTasksRepository.completeConnectorAccessTask({
        context,
        actorExternalUserId: AUDIT_ACTOR.system,
        externalAccountId: `invite_sent:${completionResult.email}`,
        connectorResult: completionResult,
        auditEvents: [
          ...(completionResult.loginRecovered
            ? [{
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
              }]
            : []),
          {
            eventType: "slack.workspace_invite.sent",
            entityType: "access_task",
            entityId: context.task.id,
            afterJson: completionResult,
            metadataJson: {
              access_request_id: context.accessRequest.id,
              employee_id: context.employee.id,
              email: completionResult.email
            }
          }
        ]
      });
    }

    await this.accessTasksRepository.markAccessTaskRunning({
      taskId: context.task.id,
      accessRequestId: context.accessRequest.id,
      actorExternalUserId: AUDIT_ACTOR.system
    });

    const connectorResult = await this.inviteUserToSlackWorkspaceOrFailTask(context, {
      email,
      fullName: context.employee.fullName
    });

    return this.accessTasksRepository.completeConnectorAccessTask({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      externalAccountId: connectorResult.userId ?? `slack-workspace:${connectorResult.email}`,
      connectorResult
    });
  }

  private async executeSlackWorkspaceMembershipRevokeTask(
    context: AccessTaskExecutionContext
  ): Promise<ExecuteAccessTaskResult> {
    this.assertPendingTask(context, { allowFailedRetry: true });

    if (this.slackWorkspaceInviteMode !== "browser") {
      const errorMessage = "Slack workspace membership revoke requires SLACK_WORKSPACE_INVITE_MODE=browser.";

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          provider: SYSTEM_KEY.slack,
          mode: "browser",
          operation: "workspace_revoke",
          ok: false,
          code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeFailed,
          message: errorMessage
        }
      });

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: errorMessage,
        code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeFailed
      });
    }

    const email = context.employee.workEmail ?? context.employee.personalEmail;

    if (!email) {
      const errorMessage = "Employee work_email or personal_email is required to revoke a Slack workspace member.";

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          provider: SYSTEM_KEY.slack,
          ok: false,
          code: "missing_user_email",
          message: errorMessage
        }
      });

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: errorMessage,
        code: "missing_user_email"
      });
    }

    const connectorResult = await this.revokeSlackWorkspaceMembershipWithBrowserOrFailTask(context, {
      email
    });

    if (connectorResult.dryRun) {
      return {
        task: context.task,
        grant: null,
        code: "slack_browser_revoke_dry_run",
        message: connectorResult.message,
        connectorResult: toSlackBrowserWorkspaceRevokeResult(connectorResult)
      };
    }

    if (!connectorResult.revoked) {
      const errorMessage = "Slack browser revoke did not deactivate the workspace member.";
      const connectorResultJson = toSlackBrowserWorkspaceRevokeResult(connectorResult);

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage,
        externalResultJson: {
          ...connectorResultJson,
          ok: false,
          code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeFailed,
          message: errorMessage
        }
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: errorMessage,
        code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeFailed
      });
    }

    return this.accessTasksRepository.completeSlackWorkspaceMembershipRevokeAccessTask({
      context,
      actorExternalUserId: AUDIT_ACTOR.system,
      connectorResult: toSlackBrowserWorkspaceRevokeResult(connectorResult)
    });
  }

  private async createGoogleWorkspaceUserOrFailTask(
    context: AccessTaskExecutionContext,
    input: {
      primaryEmail: string;
      fullName: string;
      givenName: string;
      familyName: string;
      personalEmail?: string;
    }
  ) {
    try {
      return await this.googleWorkspaceConnector.createUser(input);
    } catch (error) {
      const connectorError = normalizeGoogleWorkspaceConnectorError(error);

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: connectorError.message,
        externalResultJson: connectorError.toResult()
      });

      if (connectorError.code === GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.rateLimited) {
        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: connectorError.message,
          code: connectorError.code
        }, 429);
      }

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: connectorError.message,
        code: connectorError.code
      });
    }
  }

  private async suspendGoogleWorkspaceUserOrFailTask(
    context: AccessTaskExecutionContext,
    input: {
      primaryEmail: string;
    }
  ) {
    try {
      return await this.googleWorkspaceConnector.suspendUser(input);
    } catch (error) {
      const connectorError = normalizeGoogleWorkspaceConnectorError(error);

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: connectorError.message,
        externalResultJson: connectorError.toResult()
      });

      if (connectorError.code === GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.rateLimited) {
        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: connectorError.message,
          code: connectorError.code
        }, 429);
      }

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: connectorError.message,
        code: connectorError.code
      });
    }
  }

  private async sendGoogleWorkspaceWelcomeEmailAfterProvisioning(
    context: AccessTaskExecutionContext,
    input: {
      accessTaskId: string;
      primaryEmail: string;
      temporaryPassword?: string;
    }
  ): Promise<void> {
    try {
      await this.emailService.sendGoogleWorkspaceWelcomeEmail({
        employeeId: context.employee.id,
        accessTaskId: input.accessTaskId,
        employeeFullName: context.employee.fullName,
        personalEmail: context.employee.personalEmail,
        workEmail: input.primaryEmail,
        temporaryPassword: input.temporaryPassword
      });
    } catch {
      // Welcome email is a notification follow-up. Google provisioning has already succeeded.
    }
  }

  private async addUserToSlackChannelOrFailTask(
    context: AccessTaskExecutionContext,
    input: {
      userEmail: string;
      channelName: string;
    }
  ) {
    try {
      return await this.slackConnector.addUserToChannel(input);
    } catch (error) {
      const connectorError = normalizeSlackConnectorError(error);
      const taskError = toSlackTaskError(connectorError);

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.userNotFound) {
        const errorMessage = "Slack user not found yet. Invite may be sent but employee may not have accepted it.";

        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage,
          externalResultJson: {
            code: "slack_user_not_found_after_invite",
            retryable: true
          }
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: errorMessage,
          code: "slack_user_not_found_after_invite"
        }, 429);
      }

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.rateLimited) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async removeUserFromSlackChannelOrFailTask(
    context: AccessTaskExecutionContext,
    input: {
      userEmail: string;
      channelName: string;
    }
  ) {
    try {
      return await this.slackConnector.removeUserFromChannel(input);
    } catch (error) {
      const connectorError = normalizeSlackConnectorError(error);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.userNotFound ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.botNotInChannel
      ) {
        const hasRevokedWorkspaceMembership = await this.accessTasksRepository.hasRevokedSlackWorkspaceMembershipGrant(
          context.employee.id
        );

        if (hasRevokedWorkspaceMembership) {
          return {
            provider: SLACK_PROVIDER,
            operation: "remove_user_from_channel" as const,
            userId: null,
            userEmail: input.userEmail,
            channelId: null,
            channelName: input.channelName,
            removed: false,
            alreadyRemoved: true,
            warning: "Slack channel revoke is covered by completed workspace membership revoke.",
            raw: {
              slackError: connectorError.code,
              coveredBy: "workspace_membership_revoke"
            }
          };
        }
      }

      const taskError = toSlackRevokeTaskError(connectorError);

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.rateLimited) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async inviteUserToSlackWorkspaceOrFailTask(
    context: AccessTaskExecutionContext,
    input: {
      email: string;
      fullName: string;
    }
  ) {
    try {
      return await this.slackWorkspaceInviteConnector.inviteUserToWorkspace(input);
    } catch (error) {
      const connectorError = normalizeSlackConnectorError(error);
      const taskError = toSlackWorkspaceInviteTaskError(connectorError);

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.rateLimited) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async inviteUserToSlackWorkspaceWithBrowserOrFailTask(
    context: AccessTaskExecutionContext,
    input: {
      email: string;
      fullName: string;
    }
  ): Promise<InviteSlackWorkspaceUserResult> {
    try {
      return await this.slackBrowserInviteConnector.inviteUserToWorkspace(input);
    } catch (error) {
      const connectorError = normalizeSlackConnectorError(error);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
      ) {
        return this.recoverSlackBrowserLoginAndRetryWorkspaceInvite(context, input);
      }

      const taskError = toSlackBrowserWorkspaceInviteTaskError(connectorError);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: taskError.message,
          code: connectorError.code,
          details: taskError.result.details
        });
      }

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async activateSlackWorkspaceMembershipWithBrowserOrFailTask(
    context: AccessTaskExecutionContext,
    input: {
      email: string;
    }
  ): Promise<ActivateSlackWorkspaceUserResult> {
    try {
      return await this.slackBrowserWorkspaceRevokeConnector.activateUserInWorkspace(input);
    } catch (error) {
      const connectorError = normalizeSlackConnectorError(error);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
      ) {
        return this.recoverSlackBrowserLoginAndRetryWorkspaceActivate(context, input);
      }

      const taskError = toSlackBrowserWorkspaceActivateTaskError(connectorError);

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserActivateUiChanged) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: taskError.message,
          code: connectorError.code,
          details: taskError.result.details
        });
      }

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async revokeSlackWorkspaceMembershipWithBrowserOrFailTask(
    context: AccessTaskExecutionContext,
    input: {
      email: string;
    }
  ): Promise<RevokeSlackWorkspaceUserResult> {
    try {
      return await this.slackBrowserWorkspaceRevokeConnector.revokeUserFromWorkspace(input);
    } catch (error) {
      const connectorError = normalizeSlackConnectorError(error);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
      ) {
        return this.recoverSlackBrowserLoginAndRetryWorkspaceRevoke(context, input);
      }

      const taskError = toSlackBrowserWorkspaceRevokeTaskError(connectorError);

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: taskError.message,
          code: connectorError.code,
          details: taskError.result.details
        });
      }

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async recoverSlackBrowserLoginAndRetryWorkspaceInvite(
    context: AccessTaskExecutionContext,
    input: {
      email: string;
      fullName: string;
    }
  ): Promise<InviteSlackWorkspaceUserResult> {
    if (this.slackBrowserLoginMode !== "google_sso") {
      const taskError = toSlackBrowserWorkspaceInviteTaskError(new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        message: "Slack browser profile is not logged in."
      }));

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: taskError.message,
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        details: taskError.result.details
      });
    }

    const loginResult = await this.loginToSlackBrowserOrFailTask(context);

    try {
      const connectorResult = await this.slackBrowserInviteConnector.inviteUserToWorkspace(input);

      return {
        ...connectorResult,
        loginRecovered: loginResult.loginRecovered,
        retryAfterLogin: true
      };
    } catch (retryError) {
      const connectorError = normalizeSlackConnectorError(retryError);
      const taskError = toSlackBrowserWorkspaceInviteTaskError(connectorError);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: taskError.message,
          code: connectorError.code,
          details: taskError.result.details
        });
      }

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async recoverSlackBrowserLoginAndRetryWorkspaceActivate(
    context: AccessTaskExecutionContext,
    input: {
      email: string;
    }
  ): Promise<ActivateSlackWorkspaceUserResult> {
    if (this.slackBrowserLoginMode !== "google_sso") {
      const taskError = toSlackBrowserWorkspaceActivateTaskError(new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        message: "Slack browser profile is not logged in."
      }));

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: taskError.message,
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        details: taskError.result.details
      });
    }

    const loginResult = await this.loginToSlackBrowserOrFailTask(context);

    try {
      const connectorResult = await this.slackBrowserWorkspaceRevokeConnector.activateUserInWorkspace(input);

      return {
        ...connectorResult,
        loginRecovered: loginResult.loginRecovered,
        retryAfterLogin: true
      };
    } catch (retryError) {
      const connectorError = normalizeSlackConnectorError(retryError);
      const taskError = toSlackBrowserWorkspaceActivateTaskError(connectorError);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserActivateUiChanged ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: taskError.message,
          code: connectorError.code,
          details: taskError.result.details
        });
      }

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async recoverSlackBrowserLoginAndRetryWorkspaceRevoke(
    context: AccessTaskExecutionContext,
    input: {
      email: string;
    }
  ): Promise<RevokeSlackWorkspaceUserResult> {
    if (this.slackBrowserLoginMode !== "google_sso") {
      const taskError = toSlackBrowserWorkspaceRevokeTaskError(new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        message: "Slack browser profile is not logged in."
      }));

      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: taskError.message,
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        details: taskError.result.details
      });
    }

    const loginResult = await this.loginToSlackBrowserOrFailTask(context);

    try {
      const connectorResult = await this.slackBrowserWorkspaceRevokeConnector.revokeUserFromWorkspace(input);

      return {
        ...connectorResult,
        loginRecovered: loginResult.loginRecovered,
        retryAfterLogin: true
      };
    } catch (retryError) {
      const connectorError = normalizeSlackConnectorError(retryError);
      const taskError = toSlackBrowserWorkspaceRevokeTaskError(connectorError);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: taskError.message,
          code: connectorError.code,
          details: taskError.result.details
        });
      }

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private async loginToSlackBrowserOrFailTask(context: AccessTaskExecutionContext): Promise<SlackBrowserLoginResult> {
    try {
      return await this.slackBrowserLoginConnector.login();
    } catch (error) {
      const connectorError = normalizeSlackConnectorError(error);
      const taskError = toSlackBrowserLoginTaskError(connectorError);

      if (
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged ||
        connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: taskError.message,
          code: connectorError.code,
          details: taskError.result.details
        });
      }

      if (connectorError.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
        await this.accessTasksRepository.markAccessTaskRetrying({
          taskId: context.task.id,
          accessRequestId: context.accessRequest.id,
          actorExternalUserId: AUDIT_ACTOR.system,
          errorMessage: taskError.message,
          externalResultJson: taskError.result
        });

        throw new HttpException({
          statusCode: 429,
          error: "Too Many Requests",
          message: taskError.message,
          code: connectorError.code
        }, 429);
      }

      await this.accessTasksRepository.markAccessTaskFailed({
        taskId: context.task.id,
        accessRequestId: context.accessRequest.id,
        actorExternalUserId: AUDIT_ACTOR.system,
        errorMessage: taskError.message,
        externalResultJson: taskError.result
      });

      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        message: taskError.message,
        code: connectorError.code
      });
    }
  }

  private isGoogleWorkspaceTask(context: AccessTaskExecutionContext): boolean {
    return (
      context.system.key === SYSTEM_KEY.googleWorkspace &&
      context.resource.key === ACCESS_RESOURCE_KEY.companyEmail &&
      context.role.key === ROLE_KEY.user &&
      context.task.operation === ACCESS_TASK_OPERATION.grant
    );
  }

  private isGoogleWorkspaceRevokeTask(context: AccessTaskExecutionContext): boolean {
    return (
      context.system.key === SYSTEM_KEY.googleWorkspace &&
      context.resource.key === ACCESS_RESOURCE_KEY.companyEmail &&
      context.role.key === ROLE_KEY.user &&
      context.task.operation === ACCESS_TASK_OPERATION.revoke &&
      context.task.connector === SYSTEM_KEY.googleWorkspace
    );
  }

  private isSlackChannelTask(context: AccessTaskExecutionContext): boolean {
    return (
      context.system.key === SYSTEM_KEY.slack &&
      context.resource.resourceType === ACCESS_RESOURCE_TYPE.channel &&
      context.role.key === ROLE_KEY.member &&
      context.task.operation === ACCESS_TASK_OPERATION.grant &&
      context.task.connector === SYSTEM_KEY.slack
    );
  }

  private isSlackChannelRevokeTask(context: AccessTaskExecutionContext): boolean {
    return (
      context.system.key === SYSTEM_KEY.slack &&
      context.resource.resourceType === ACCESS_RESOURCE_TYPE.channel &&
      context.role.key === ROLE_KEY.member &&
      context.task.operation === ACCESS_TASK_OPERATION.revoke &&
      context.task.connector === SYSTEM_KEY.slack
    );
  }

  private isSlackWorkspaceMembershipTask(context: AccessTaskExecutionContext): boolean {
    return (
      context.system.key === SYSTEM_KEY.slack &&
      context.resource.key === ACCESS_RESOURCE_KEY.workspaceMembership &&
      context.resource.resourceType === ACCESS_RESOURCE_TYPE.workspace &&
      context.role.key === ROLE_KEY.member &&
      context.task.operation === ACCESS_TASK_OPERATION.grant &&
      context.task.connector === SYSTEM_KEY.slack
    );
  }

  private isSlackWorkspaceMembershipRevokeTask(context: AccessTaskExecutionContext): boolean {
    return (
      context.system.key === SYSTEM_KEY.slack &&
      context.resource.key === ACCESS_RESOURCE_KEY.workspaceMembership &&
      context.resource.resourceType === ACCESS_RESOURCE_TYPE.workspace &&
      context.role.key === ROLE_KEY.member &&
      context.task.operation === ACCESS_TASK_OPERATION.revoke &&
      context.task.connector === SYSTEM_KEY.slack
    );
  }

  private assertPendingTask(
    context: AccessTaskExecutionContext,
    options: { allowFailedRetry?: boolean } = {}
  ): void {
    if (
      context.task.status !== ACCESS_TASK_STATUS.pending &&
      context.task.status !== ACCESS_TASK_STATUS.pendingManual &&
      context.task.status !== ACCESS_TASK_STATUS.pendingDependency &&
      context.task.status !== ACCESS_TASK_STATUS.retrying &&
      !(options.allowFailedRetry === true && context.task.status === ACCESS_TASK_STATUS.failed)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Only pending access tasks can be executed."
      });
    }
  }

}

function sanitizeGoogleWorkspaceConnectorResult(
  result: CreateGoogleWorkspaceUserResult
): Omit<CreateGoogleWorkspaceUserResult, "temporaryPassword"> {
  const { temporaryPassword: _temporaryPassword, ...safeResult } = result;
  return safeResult;
}

function sanitizeGoogleWorkspaceSuspendResult(
  result: SuspendGoogleWorkspaceUserResult
): SuspendGoogleWorkspaceUserResult {
  return result;
}

function splitFullName(fullName: string): { givenName: string; familyName: string } {
  const parts = fullName.trim().split(/\s+/u).filter(Boolean);
  const givenName = parts[0] ?? fullName.trim();
  const familyName = parts.at(-1) ?? givenName;

  return {
    givenName,
    familyName
  };
}

function normalizeSlackChannelName(channelName: string): string {
  return channelName.trim().replace(/^#+/u, "").toLowerCase();
}

function toSlackTaskError(error: ReturnType<typeof normalizeSlackConnectorError>): {
  message: string;
  result: ReturnType<ReturnType<typeof normalizeSlackConnectorError>["toResult"]>;
} {
  const result = error.toResult();

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.userNotFound) {
    const message = "Slack user was not found. The employee may not have accepted the Slack workspace invite yet.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.botNotInChannel) {
    const message = "Bot/admin must be added to the channel before inviting users.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.missingScope) {
    const message = "Slack token is missing a required scope.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.rateLimited) {
    const message = "Slack API rate limit exceeded. The access task will be retried.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  return {
    message: error.message,
    result
  };
}

function toSlackRevokeTaskError(error: ReturnType<typeof normalizeSlackConnectorError>): {
  message: string;
  result: ReturnType<ReturnType<typeof normalizeSlackConnectorError>["toResult"]>;
} {
  const result = error.toResult();

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.userNotFound) {
    const message = "Slack user was not found. Workspace revoke must complete before treating channel revoke as covered.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.botNotInChannel) {
    const message = "Bot/admin must be in the Slack channel to remove the user unless workspace revoke has already completed.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.missingScope) {
    const message = "Slack token is missing a required revoke scope.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.rateLimited) {
    const message = "Slack API rate limit exceeded. The revoke task will be retried.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  return {
    message: error.message,
    result
  };
}

function toSlackWorkspaceInviteTaskError(error: ReturnType<typeof normalizeSlackConnectorError>): {
  message: string;
  result: ReturnType<ReturnType<typeof normalizeSlackConnectorError>["toResult"]>;
} {
  const result = error.toResult();

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.missingScope) {
    const message = "Slack admin token is missing a required scope.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.rateLimited) {
    const message = "Slack Admin API rate limit exceeded. The access task will be retried.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  return {
    message: error.message,
    result
  };
}

function toSlackBrowserWorkspaceInviteTaskError(error: ReturnType<typeof normalizeSlackConnectorError>): {
  message: string;
  result: ReturnType<ReturnType<typeof normalizeSlackConnectorError>["toResult"]>;
} {
  const result = error.toResult();

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn) {
    const message = "Slack browser profile is not logged in. Run the Slack browser login setup first.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired) {
    const message = "Slack browser profile requires SSO, MFA, or email verification before invites can be sent.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged) {
    const message = "Slack invite UI could not be found. The browser automation selectors may need an update.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
    const message = "Slack browser invite timed out. The access task will be retried.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  return {
    message: error.message,
    result
  };
}

function toSlackBrowserWorkspaceRevokeTaskError(error: ReturnType<typeof normalizeSlackConnectorError>): {
  message: string;
  result: ReturnType<ReturnType<typeof normalizeSlackConnectorError>["toResult"]>;
} {
  const result = error.toResult();

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn) {
    const message = "Slack browser profile is not logged in. Run the Slack browser login setup first.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired) {
    const message = "Slack browser profile requires SSO, MFA, or email verification before workspace revoke can run.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged) {
    const message = "Slack workspace revoke UI could not be found. The browser automation selectors may need an update.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
    const message = "Slack browser workspace revoke timed out. The access task will be retried.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  return {
    message: error.message,
    result
  };
}

function toSlackBrowserWorkspaceActivateTaskError(error: ReturnType<typeof normalizeSlackConnectorError>): {
  message: string;
  result: ReturnType<ReturnType<typeof normalizeSlackConnectorError>["toResult"]>;
} {
  const result = error.toResult();

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn) {
    const message = "Slack browser profile is not logged in. Run the Slack browser login setup first.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired) {
    const message = "Slack browser profile requires SSO, MFA, or email verification before workspace activation can run.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserActivateUiChanged) {
    const message = "Slack workspace activation UI could not be found. The browser automation selectors may need an update.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
    const message = "Slack browser workspace activation timed out. The access task will be retried.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  return {
    message: error.message,
    result
  };
}

function toSlackBrowserLoginTaskError(error: ReturnType<typeof normalizeSlackConnectorError>): {
  message: string;
  result: ReturnType<ReturnType<typeof normalizeSlackConnectorError>["toResult"]>;
} {
  const result = error.toResult();

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn) {
    const message = "Slack browser Google SSO login is not configured or could not start.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired) {
    const message = "Slack browser Google SSO login requires MFA, SSO approval, CAPTCHA, recovery, or another unsupported challenge.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged) {
    const message = "Slack browser Google SSO login UI could not be found. The browser automation selectors may need an update.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  if (error.code === SLACK_CONNECTOR_ERROR_CODE.browserTimeout) {
    const message = "Slack browser Google SSO login timed out. The access task will be retried.";
    return {
      message,
      result: {
        ...result,
        message
      }
    };
  }

  return {
    message: error.message,
    result
  };
}

function toSlackBrowserWorkspaceInviteResult(
  result: InviteSlackWorkspaceUserResult
): Record<string, unknown> & {
  provider: typeof SLACK_PROVIDER;
  mode: "browser";
  inviteSubmitted: boolean;
  dryRun: boolean;
  email: string;
  membershipPolicy: "invite_sent_treated_as_active";
  loginRecovered?: boolean;
  retryAfterLogin?: boolean;
} {
  return {
    provider: result.provider,
    mode: result.mode,
    inviteSubmitted: result.inviteSubmitted,
    dryRun: result.dryRun,
    email: result.email,
    message: result.message,
    ...(result.screenshotPath ? { screenshotPath: result.screenshotPath } : {}),
    ...(result.loginRecovered !== undefined ? { loginRecovered: result.loginRecovered } : {}),
    ...(result.retryAfterLogin !== undefined ? { retryAfterLogin: result.retryAfterLogin } : {}),
    membershipPolicy: "invite_sent_treated_as_active"
  };
}

function toSlackBrowserWorkspaceActivateResult(
  result: ActivateSlackWorkspaceUserResult
): Record<string, unknown> & {
  provider: typeof SLACK_PROVIDER;
  mode: "browser";
  operation: "workspace_activate";
  email: string;
  activated: boolean;
  alreadyActive: boolean;
  notFound: boolean;
  dryRun: boolean;
  loginRecovered?: boolean;
  retryAfterLogin?: boolean;
} {
  return {
    provider: result.provider,
    mode: result.mode,
    operation: result.operation,
    email: result.email,
    activated: result.activated,
    alreadyActive: result.alreadyActive,
    notFound: result.notFound,
    dryRun: result.dryRun,
    message: result.message,
    ...(result.loginRecovered !== undefined ? { loginRecovered: result.loginRecovered } : {}),
    ...(result.retryAfterLogin !== undefined ? { retryAfterLogin: result.retryAfterLogin } : {})
  };
}

function offboardingExecutionStateForIntakeStatus(status: string): string {
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

  return status;
}

function reasonForBlockedOffboardingRevokeExecution(status: string): string {
  if (status === OFFBOARDING_INTAKE_STATUS.waitingForReview) {
    return "waiting_for_approval";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.completed) {
    return "already_finalized";
  }

  return "invalid_revoke_execution_state";
}

function messageForBlockedOffboardingRevokeExecution(status: string): string {
  if (status === OFFBOARDING_INTAKE_STATUS.waitingForReview) {
    return "Offboarding is waiting for approval. Revoke tasks cannot be executed yet.";
  }

  if (status === OFFBOARDING_INTAKE_STATUS.completed) {
    return "Offboarding is already finalized. Revoke tasks are already completed.";
  }

  return "Offboarding revoke task cannot be executed from the current intake state.";
}

function toSlackBrowserWorkspaceRevokeResult(
  result: RevokeSlackWorkspaceUserResult
): Record<string, unknown> & {
  provider: typeof SLACK_PROVIDER;
  mode: "browser";
  operation: "workspace_revoke";
  email: string;
  revoked: boolean;
  alreadyInactive: boolean;
  dryRun: boolean;
  loginRecovered?: boolean;
  retryAfterLogin?: boolean;
} {
  return {
    provider: result.provider,
    mode: result.mode,
    operation: result.operation,
    email: result.email,
    revoked: result.revoked,
    alreadyInactive: result.alreadyInactive,
    dryRun: result.dryRun,
    message: result.message,
    ...(result.loginRecovered !== undefined ? { loginRecovered: result.loginRecovered } : {}),
    ...(result.retryAfterLogin !== undefined ? { retryAfterLogin: result.retryAfterLogin } : {})
  };
}

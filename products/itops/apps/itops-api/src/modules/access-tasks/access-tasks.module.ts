import { Module } from "@nestjs/common";
import { loadConfig } from "@itops/config";
import {
  GoogleWorkspaceConnector,
  MockGoogleWorkspaceConnector,
  MockSlackConnector,
  MockSlackWorkspaceInviteConnector,
  SlackBrowserInviteConnector,
  SlackBrowserLoginConnector,
  SlackBrowserWorkspaceRevokeConnector,
  SlackConnector,
  SlackConnectorError,
  SLACK_CONNECTOR_ERROR_CODE,
  SlackWorkspaceInviteConnector
} from "@itops/connectors";

import {
  AccessTaskExecutorService,
  GOOGLE_WORKSPACE_CONNECTOR,
  GOOGLE_WORKSPACE_EMAIL_DOMAIN,
  SLACK_BROWSER_INVITE_CONNECTOR,
  SLACK_BROWSER_LOGIN_CONNECTOR,
  SLACK_BROWSER_LOGIN_MODE,
  SLACK_BROWSER_WORKSPACE_URL,
  SLACK_BROWSER_WORKSPACE_REVOKE_CONNECTOR,
  SLACK_CONNECTOR,
  SLACK_WORKSPACE_INVITE_CONNECTOR,
  SLACK_WORKSPACE_INVITE_MODE
} from "./access-task-executor.service.js";
import { AccessTasksController } from "./access-tasks.controller.js";
import { AccessTasksRepository } from "./access-tasks.repository.js";
import { AccessTasksService } from "./access-tasks.service.js";
import { EmailGeneratorService } from "../google-workspace/email-generator.service.js";
import { EmailModule } from "../email/email.module.js";

@Module({
  imports: [EmailModule],
  controllers: [AccessTasksController],
  providers: [
    AccessTasksRepository,
    AccessTasksService,
    AccessTaskExecutorService,
    EmailGeneratorService,
    {
      provide: GOOGLE_WORKSPACE_CONNECTOR,
      useFactory: () => {
        const config = loadConfig().googleWorkspace;

        if (!config.enabled) {
          return new MockGoogleWorkspaceConnector();
        }

        return new GoogleWorkspaceConnector({
          adminEmail: config.adminEmail!,
          clientEmail: config.clientEmail!,
          privateKey: config.privateKey!
        });
      }
    },
    {
      provide: GOOGLE_WORKSPACE_EMAIL_DOMAIN,
      useFactory: () => loadConfig().googleWorkspace.domain
    },
    {
      provide: SLACK_CONNECTOR,
      useFactory: () => {
        const config = loadConfig().slackChannelConnector;

        if (config.mode === "mock") {
          return new MockSlackConnector();
        }

        return new SlackConnector({
          botToken: config.botToken!
        });
      }
    },
    {
      provide: SLACK_WORKSPACE_INVITE_CONNECTOR,
      useFactory: () => {
        const config = loadConfig().slackWorkspaceInvite;

        // Manual and browser modes do not use the Slack Admin API connector.
        if (config.mode !== "automated") {
          return new MockSlackWorkspaceInviteConnector();
        }

        return new SlackWorkspaceInviteConnector({
          adminToken: config.adminToken!,
          teamId: config.teamId,
          defaultChannelIds: config.defaultInviteChannelIds
        });
      }
    },
    {
      provide: SLACK_BROWSER_INVITE_CONNECTOR,
      useFactory: () => {
        const config = loadConfig().slackWorkspaceInvite;

        if (config.mode !== "browser") {
          return {
            inviteUserToWorkspace: async () => {
              throw new SlackConnectorError({
                code: SLACK_CONNECTOR_ERROR_CODE.browserInviteFailed,
                message: "Slack browser invite connector is not enabled."
              });
            }
          };
        }

        return new SlackBrowserInviteConnector({
          workspaceUrl: config.browserWorkspaceUrl!,
          profileDir: config.browserProfileDir!,
          dryRun: config.browserDryRun,
          headless: config.browserHeadless,
          timeoutMs: config.browserInviteTimeoutMs
        });
      }
    },
    {
      provide: SLACK_BROWSER_WORKSPACE_REVOKE_CONNECTOR,
      useFactory: () => {
        const config = loadConfig().slackWorkspaceInvite;

        if (config.mode !== "browser") {
          return {
            revokeUserFromWorkspace: async () => {
              throw new SlackConnectorError({
                code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeFailed,
                message: "Slack browser workspace revoke connector is not enabled."
              });
            },
            activateUserInWorkspace: async () => {
              throw new SlackConnectorError({
                code: SLACK_CONNECTOR_ERROR_CODE.browserActivateFailed,
                message: "Slack browser workspace activate connector is not enabled."
              });
            }
          };
        }

        return new SlackBrowserWorkspaceRevokeConnector({
          workspaceUrl: config.browserWorkspaceUrl!,
          profileDir: config.browserProfileDir!,
          dryRun: config.browserDryRun,
          headless: config.browserHeadless,
          timeoutMs: config.browserInviteTimeoutMs
        });
      }
    },
    {
      provide: SLACK_BROWSER_LOGIN_CONNECTOR,
      useFactory: () => {
        const config = loadConfig().slackWorkspaceInvite;

        if (config.mode !== "browser") {
          return {
            login: async () => {
              throw new SlackConnectorError({
                code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
                message: "Slack browser login connector is not enabled."
              });
            }
          };
        }

        return new SlackBrowserLoginConnector({
          workspaceUrl: config.browserWorkspaceUrl!,
          profileDir: config.browserProfileDir!,
          loginMode: config.browserLoginMode,
          loginEmail: config.browserLoginEmail,
          loginPassword: config.browserLoginPassword,
          headless: config.browserHeadless,
          timeoutMs: config.browserInviteTimeoutMs
        });
      }
    },
    {
      provide: SLACK_WORKSPACE_INVITE_MODE,
      useFactory: () => loadConfig().slackWorkspaceInvite.mode
    },
    {
      provide: SLACK_BROWSER_LOGIN_MODE,
      useFactory: () => loadConfig().slackWorkspaceInvite.browserLoginMode
    },
    {
      provide: SLACK_BROWSER_WORKSPACE_URL,
      useFactory: () => loadConfig().slackWorkspaceInvite.browserWorkspaceUrl
    }
  ],
  exports: [AccessTaskExecutorService, SLACK_CONNECTOR]
})
export class AccessTasksModule {}

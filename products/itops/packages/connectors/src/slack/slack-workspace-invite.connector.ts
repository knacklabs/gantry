import type { SlackWorkspaceInviteConnectorInterface } from "./slack-workspace-invite-connector.interface.js";
import {
  SLACK_CONNECTOR_ERROR_CODE,
  SLACK_PROVIDER,
  SlackConnectorError,
  type InviteSlackUserToWorkspaceInput,
  type SlackConnectorErrorCode,
  type SlackWorkspaceInviteResult
} from "./slack.types.js";

const SLACK_API_BASE_URL = "https://slack.com/api";

export type SlackWorkspaceInviteConnectorConfig = {
  adminToken: string;
  teamId?: string;
  defaultChannelIds?: string[];
  adminClient?: SlackAdminUsersClient;
};

export type SlackAdminUsersClient = {
  invite(input: {
    email: string;
    realName?: string;
    channelIds?: string[];
    teamId?: string;
  }): Promise<SlackAdminUsersInviteResponse>;
};

type SlackAdminUsersInviteResponse = {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  user?: {
    id?: string;
  };
  invite_id?: string;
};

export class SlackWorkspaceInviteConnector implements SlackWorkspaceInviteConnectorInterface {
  private readonly adminClient: SlackAdminUsersClient;
  private readonly teamId?: string;
  private readonly defaultChannelIds: string[];

  constructor(config: SlackWorkspaceInviteConnectorConfig) {
    this.adminClient = config.adminClient ?? new FetchSlackAdminUsersClient(config.adminToken);
    this.teamId = config.teamId;
    this.defaultChannelIds = config.defaultChannelIds ?? [];
  }

  async inviteUserToWorkspace(input: InviteSlackUserToWorkspaceInput): Promise<SlackWorkspaceInviteResult> {
    const email = normalizeEmail(input.email);
    const channelIds = input.channelIds ?? this.defaultChannelIds;
    const response = await this.adminClient.invite({
      email,
      realName: input.fullName,
      channelIds,
      teamId: this.teamId
    });

    if (!response.ok) {
      if (isAlreadyInvited(response.error) || isAlreadyInWorkspace(response.error)) {
        return toInviteResult({
          email,
          userId: response.user?.id,
          teamId: this.teamId,
          channelIds,
          invited: false,
          alreadyInvited: isAlreadyInvited(response.error),
          alreadyInWorkspace: isAlreadyInWorkspace(response.error),
          slackError: response.error
        });
      }

      throw normalizeSlackAdminInviteResponse(response, "Slack workspace invite failed.");
    }

    return toInviteResult({
      email,
      userId: response.user?.id,
      teamId: this.teamId,
      channelIds,
      invited: true,
      alreadyInvited: false,
      alreadyInWorkspace: false
    });
  }
}

class FetchSlackAdminUsersClient implements SlackAdminUsersClient {
  constructor(private readonly adminToken: string) {}

  async invite(input: {
    email: string;
    realName?: string;
    channelIds?: string[];
    teamId?: string;
  }): Promise<SlackAdminUsersInviteResponse> {
    const body = new URLSearchParams();
    body.set("email", input.email);

    if (input.realName) {
      body.set("real_name", input.realName);
    }

    if (input.channelIds && input.channelIds.length > 0) {
      body.set("channel_ids", input.channelIds.join(","));
    }

    if (input.teamId) {
      body.set("team_id", input.teamId);
    }

    const response = await fetch(`${SLACK_API_BASE_URL}/admin.users.invite`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.adminToken}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (response.status === 429) {
      return {
        ok: false,
        error: "ratelimited"
      };
    }

    const data = await response.json() as SlackAdminUsersInviteResponse;

    if (!response.ok && data.ok !== false) {
      return {
        ...data,
        ok: false,
        error: `http_${response.status}`
      };
    }

    return data;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isAlreadyInvited(error: string | undefined): boolean {
  return error === "already_invited" || error === "user_already_invited";
}

function isAlreadyInWorkspace(error: string | undefined): boolean {
  return error === "already_in_team" || error === "user_already_in_team" || error === "already_in_workspace";
}

function toInviteResult(input: {
  email: string;
  invited: boolean;
  alreadyInWorkspace: boolean;
  alreadyInvited: boolean;
  channelIds: string[];
  userId?: string;
  teamId?: string;
  slackError?: string;
}): SlackWorkspaceInviteResult {
  return {
    provider: SLACK_PROVIDER,
    email: input.email,
    invited: input.invited,
    alreadyInWorkspace: input.alreadyInWorkspace,
    alreadyInvited: input.alreadyInvited,
    userId: input.userId,
    teamId: input.teamId,
    channelIds: input.channelIds,
    raw: {
      userId: input.userId,
      teamId: input.teamId,
      channelIds: input.channelIds,
      ...(input.slackError ? { slackError: input.slackError } : {})
    }
  };
}

function normalizeSlackAdminInviteResponse(
  response: {
    error?: string;
    needed?: string;
    provided?: string;
  },
  fallbackMessage: string
): SlackConnectorError {
  const code = codeForSlackAdminError(response.error);

  return new SlackConnectorError({
    code,
    message: messageForSlackAdminError(response.error, fallbackMessage),
    statusCode: code === SLACK_CONNECTOR_ERROR_CODE.rateLimited ? 429 : undefined,
    details: {
      slackError: response.error,
      needed: response.needed,
      provided: response.provided
    }
  });
}

function codeForSlackAdminError(error: string | undefined): SlackConnectorErrorCode {
  if (error === "not_authed" || error === "invalid_auth" || error === "account_inactive") {
    return SLACK_CONNECTOR_ERROR_CODE.authFailed;
  }

  if (error === "missing_scope") {
    return SLACK_CONNECTOR_ERROR_CODE.missingScope;
  }

  if (error === "ratelimited") {
    return SLACK_CONNECTOR_ERROR_CODE.rateLimited;
  }

  if (error) {
    return SLACK_CONNECTOR_ERROR_CODE.slackApiError;
  }

  return SLACK_CONNECTOR_ERROR_CODE.unknown;
}

function messageForSlackAdminError(error: string | undefined, fallbackMessage: string): string {
  if (error === "missing_scope") {
    return "Slack admin token is missing a required scope.";
  }

  if (error === "not_authed" || error === "invalid_auth" || error === "account_inactive") {
    return "Slack admin authentication failed.";
  }

  if (error === "ratelimited") {
    return "Slack Admin API rate limit exceeded.";
  }

  return fallbackMessage;
}

export const SLACK_PROVIDER = "slack" as const;

export type SlackProvider = typeof SLACK_PROVIDER;

export type SlackUser = {
  id: string;
  email?: string;
  name?: string;
  realName?: string;
  deleted?: boolean;
};

export type SlackChannel = {
  id: string;
  name: string;
  isPrivate?: boolean;
  isArchived?: boolean;
};

export type LookupSlackUserByEmailInput = {
  email: string;
};

export type FindSlackChannelInput = {
  channelName: string;
};

export type FindSlackChannelByIdInput = {
  channelId: string;
};

export type AddUserToSlackChannelInput = {
  userEmail: string;
  channelName: string;
};

export type AddUserToSlackChannelResult = {
  provider: SlackProvider;
  userId: string;
  userEmail: string;
  channelId: string;
  channelName: string;
  added: boolean;
  alreadyInChannel: boolean;
  raw?: unknown;
};

export type RemoveUserFromSlackChannelInput = {
  userEmail: string;
  channelName: string;
};

export type RemoveUserFromSlackChannelResult = {
  provider: SlackProvider;
  operation: "remove_user_from_channel";
  userId: string | null;
  userEmail: string;
  channelId: string | null;
  channelName: string;
  removed: boolean;
  alreadyRemoved: boolean;
  warning?: string;
  raw?: unknown;
};

export type InviteSlackUserToWorkspaceInput = {
  email: string;
  fullName?: string;
  channelIds?: string[];
};

export type SlackWorkspaceInviteResult = {
  provider: SlackProvider;
  email: string;
  invited: boolean;
  alreadyInWorkspace: boolean;
  alreadyInvited: boolean;
  userId?: string;
  teamId?: string;
  channelIds: string[];
  raw?: unknown;
};

export type InviteSlackWorkspaceUserInput = {
  email: string;
  fullName?: string;
};

export type InviteSlackWorkspaceUserResult = {
  provider: SlackProvider;
  mode: "browser";
  email: string;
  inviteSubmitted: boolean;
  dryRun: boolean;
  message: string;
  screenshotPath?: string;
  loginRecovered?: boolean;
  retryAfterLogin?: boolean;
};

export type RevokeSlackWorkspaceUserInput = {
  email: string;
};

export type ActivateSlackWorkspaceUserInput = {
  email: string;
};

export type RevokeSlackWorkspaceUserResult = {
  provider: SlackProvider;
  mode: "browser";
  operation: "workspace_revoke";
  email: string;
  revoked: boolean;
  alreadyInactive: boolean;
  dryRun: boolean;
  message: string;
  loginRecovered?: boolean;
  retryAfterLogin?: boolean;
};

export type ActivateSlackWorkspaceUserResult = {
  provider: SlackProvider;
  mode: "browser";
  operation: "workspace_activate";
  email: string;
  activated: boolean;
  alreadyActive: boolean;
  notFound: boolean;
  dryRun: boolean;
  message: string;
  loginRecovered?: boolean;
  retryAfterLogin?: boolean;
};

export const SLACK_CONNECTOR_ERROR_CODE = {
  authFailed: "slack_auth_failed",
  missingScope: "slack_missing_scope",
  userNotFound: "slack_user_not_found",
  channelNotFound: "slack_channel_not_found",
  botNotInChannel: "slack_bot_not_in_channel",
  alreadyInChannel: "slack_already_in_channel",
  rateLimited: "slack_rate_limited",
  slackApiError: "slack_api_error",
  browserNotLoggedIn: "slack_browser_not_logged_in",
  browserInviteUiChanged: "slack_browser_invite_ui_changed",
  browserRevokeUiChanged: "slack_browser_revoke_ui_changed",
  browserActivateUiChanged: "slack_browser_activate_ui_changed",
  browserInviteFailed: "slack_browser_invite_failed",
  browserRevokeFailed: "slack_browser_revoke_failed",
  browserActivateFailed: "slack_browser_activate_failed",
  browserTimeout: "slack_browser_timeout",
  browserMfaOrSsoRequired: "slack_browser_mfa_or_sso_required",
  browserUnknown: "slack_browser_unknown_error",
  unknown: "slack_unknown_error"
} as const;

export type SlackConnectorErrorCode =
  (typeof SLACK_CONNECTOR_ERROR_CODE)[keyof typeof SLACK_CONNECTOR_ERROR_CODE];

export type SlackConnectorErrorResult = {
  provider: SlackProvider;
  ok: false;
  code: SlackConnectorErrorCode;
  message: string;
  statusCode?: number;
  details?: Record<string, unknown>;
};

export class SlackConnectorError extends Error {
  readonly code: SlackConnectorErrorCode;
  readonly statusCode?: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: SlackConnectorErrorCode;
    message: string;
    statusCode?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "SlackConnectorError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.details = input.details;
  }

  toResult(): SlackConnectorErrorResult {
    return {
      provider: SLACK_PROVIDER,
      ok: false,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details
    };
  }
}

export function normalizeSlackConnectorError(error: unknown): SlackConnectorError {
  if (error instanceof SlackConnectorError) {
    return error;
  }

  return new SlackConnectorError({
    code: SLACK_CONNECTOR_ERROR_CODE.unknown,
    message: "Slack connector failed.",
    cause: error
  });
}

import type { SlackConnectorInterface } from "./slack-connector.interface.js";
import {
  SLACK_CONNECTOR_ERROR_CODE,
  SLACK_PROVIDER,
  SlackConnectorError,
  type AddUserToSlackChannelInput,
  type AddUserToSlackChannelResult,
  type FindSlackChannelByIdInput,
  type FindSlackChannelInput,
  type LookupSlackUserByEmailInput,
  type RemoveUserFromSlackChannelInput,
  type RemoveUserFromSlackChannelResult,
  type SlackChannel,
  type SlackConnectorErrorCode,
  type SlackUser
} from "./slack.types.js";

const SLACK_API_BASE_URL = "https://slack.com/api";
const PAGE_LIMIT = 200;

export type SlackConnectorConfig = {
  botToken: string;
  webClient?: SlackWebApiClient;
};

export type SlackWebApiClient = {
  lookupUserByEmail(input: { email: string }): Promise<SlackApiResponse<SlackUserResponse>>;
  getConversationInfo(input: {
    channel: string;
  }): Promise<SlackApiResponse<ConversationInfoResponse>>;
  listConversations(input: {
    cursor?: string;
    limit: number;
    types: string;
  }): Promise<SlackApiResponse<ConversationsListResponse>>;
  listConversationMembers(input: {
    channel: string;
    cursor?: string;
    limit: number;
  }): Promise<SlackApiResponse<ConversationMembersResponse>>;
  inviteToConversation(input: {
    channel: string;
    users: string;
  }): Promise<SlackApiResponse<ConversationInviteResponse>>;
  kickFromConversation(input: {
    channel: string;
    user: string;
  }): Promise<SlackApiResponse<Record<string, unknown>>>;
};

type SlackApiResponse<T> = T & {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackUserResponse = {
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
    profile?: {
      email?: string;
    };
    deleted?: boolean;
  };
};

type ConversationsListResponse = {
  channels?: Array<{
    id?: string;
    name?: string;
    is_private?: boolean;
    is_archived?: boolean;
  }>;
};

type ConversationInfoResponse = {
  channel?: {
    id?: string;
    name?: string;
    is_private?: boolean;
    is_archived?: boolean;
  };
};

type ConversationMembersResponse = {
  members?: string[];
};

type ConversationInviteResponse = {
  channel?: {
    id?: string;
    name?: string;
  };
};

export class SlackConnector implements SlackConnectorInterface {
  private readonly webClient: SlackWebApiClient;

  constructor(config: SlackConnectorConfig) {
    this.webClient = config.webClient ?? new FetchSlackWebApiClient(config.botToken);
  }

  async lookupUserByEmail(input: LookupSlackUserByEmailInput): Promise<SlackUser | null> {
    const email = normalizeEmail(input.email);
    const response = await this.webClient.lookupUserByEmail({ email });

    if (!response.ok) {
      if (isSlackUserNotFound(response.error)) {
        return null;
      }

      throw normalizeSlackApiResponse(response, "Slack user lookup failed.");
    }

    if (!response.user?.id) {
      throw new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.slackApiError,
        message: "Slack user lookup response did not include a user id.",
        details: {
          slackError: response.error
        }
      });
    }

    return {
      id: response.user.id,
      email: response.user.profile?.email ? normalizeEmail(response.user.profile.email) : email,
      name: response.user.name,
      realName: response.user.real_name,
      deleted: response.user.deleted
    };
  }

  async findChannelByName(input: FindSlackChannelInput): Promise<SlackChannel | null> {
    const channelName = normalizeChannelName(input.channelName);
    let cursor: string | undefined;

    do {
      const response = await this.webClient.listConversations({
        cursor,
        limit: PAGE_LIMIT,
        types: "public_channel,private_channel"
      });

      if (!response.ok) {
        throw normalizeSlackApiResponse(response, "Slack channel lookup failed.");
      }

      const channel = response.channels?.find((entry) => normalizeChannelName(entry.name ?? "") === channelName);

      if (channel) {
        if (!channel.id || !channel.name) {
          throw new SlackConnectorError({
            code: SLACK_CONNECTOR_ERROR_CODE.slackApiError,
            message: "Slack channel lookup response did not include required channel fields.",
            details: {
              channelId: channel.id,
              channelName: channel.name
            }
          });
        }

        return {
          id: channel.id,
          name: normalizeChannelName(channel.name),
          isPrivate: channel.is_private,
          isArchived: channel.is_archived
        };
      }

      cursor = nextCursor(response);
    } while (cursor);

    return null;
  }

  async findChannelById(input: FindSlackChannelByIdInput): Promise<SlackChannel | null> {
    const channelId = input.channelId.trim();

    if (!channelId) {
      return null;
    }

    const response = await this.webClient.getConversationInfo({
      channel: channelId
    });

    if (!response.ok) {
      if (response.error === "channel_not_found") {
        return null;
      }

      throw normalizeSlackApiResponse(response, "Slack channel lookup failed.", {
        channelId
      });
    }

    const channel = response.channel;

    if (!channel?.id || !channel.name) {
      throw new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.slackApiError,
        message: "Slack channel lookup response did not include required channel fields.",
        details: {
          channelId: channel?.id ?? channelId,
          channelName: channel?.name
        }
      });
    }

    return {
      id: channel.id,
      name: normalizeChannelName(channel.name),
      isPrivate: channel.is_private,
      isArchived: channel.is_archived
    };
  }

  async isUserInChannel(input: { userId: string; channelId: string }): Promise<boolean> {
    let cursor: string | undefined;

    do {
      const response = await this.webClient.listConversationMembers({
        channel: input.channelId,
        cursor,
        limit: PAGE_LIMIT
      });

      if (!response.ok) {
        throw normalizeSlackApiResponse(response, "Slack channel membership lookup failed.", {
          channelId: input.channelId,
          userId: input.userId
        });
      }

      if (response.members?.includes(input.userId)) {
        return true;
      }

      cursor = nextCursor(response);
    } while (cursor);

    return false;
  }

  async addUserToChannel(input: AddUserToSlackChannelInput): Promise<AddUserToSlackChannelResult> {
    const userEmail = normalizeEmail(input.userEmail);
    const channelName = normalizeChannelName(input.channelName);
    const user = await this.lookupUserByEmail({ email: userEmail });

    if (!user) {
      throw new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.userNotFound,
        message: "Slack user was not found for the employee email.",
        details: {
          userEmail
        }
      });
    }

    const channel = await this.findChannelByName({ channelName });

    if (!channel) {
      throw new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.channelNotFound,
        message: "Slack channel was not found.",
        details: {
          channelName
        }
      });
    }

    const alreadyMember = await this.isUserInChannel({
      userId: user.id,
      channelId: channel.id
    });

    if (alreadyMember) {
      return toAddUserResult({
        userId: user.id,
        userEmail,
        channelId: channel.id,
        channelName,
        added: false,
        alreadyInChannel: true
      });
    }

    const response = await this.webClient.inviteToConversation({
      channel: channel.id,
      users: user.id
    });

    if (!response.ok) {
      if (response.error === "already_in_channel") {
        return toAddUserResult({
          userId: user.id,
          userEmail,
          channelId: channel.id,
          channelName,
          added: false,
          alreadyInChannel: true,
          slackError: response.error
        });
      }

      throw normalizeSlackApiResponse(response, "Slack channel invite failed.", {
        channelId: channel.id,
        userId: user.id
      });
    }

    return toAddUserResult({
      userId: user.id,
      userEmail,
      channelId: response.channel?.id ?? channel.id,
      channelName: normalizeChannelName(response.channel?.name ?? channelName),
      added: true,
      alreadyInChannel: false
    });
  }

  async removeUserFromChannel(input: RemoveUserFromSlackChannelInput): Promise<RemoveUserFromSlackChannelResult> {
    const userEmail = normalizeEmail(input.userEmail);
    const channelName = normalizeChannelName(input.channelName);
    const user = await this.lookupUserByEmail({ email: userEmail });

    if (!user) {
      throw new SlackConnectorError({
        code: SLACK_CONNECTOR_ERROR_CODE.userNotFound,
        message: "Slack user was not found for the employee email.",
        details: {
          userEmail
        }
      });
    }

    const channel = await this.findChannelByName({ channelName });

    if (!channel) {
      return toRemoveUserResult({
        userId: user.id,
        userEmail,
        channelId: null,
        channelName,
        removed: false,
        alreadyRemoved: true,
        warning: "Slack channel was not found; treating offboarding channel revoke as already removed.",
        slackError: "channel_not_found"
      });
    }

    const isMember = await this.isUserInChannel({
      userId: user.id,
      channelId: channel.id
    });

    if (!isMember) {
      return toRemoveUserResult({
        userId: user.id,
        userEmail,
        channelId: channel.id,
        channelName,
        removed: false,
        alreadyRemoved: true
      });
    }

    const response = await this.webClient.kickFromConversation({
      channel: channel.id,
      user: user.id
    });

    if (!response.ok) {
      if (response.error === "not_in_channel" || response.error === "user_not_found") {
        return toRemoveUserResult({
          userId: user.id,
          userEmail,
          channelId: channel.id,
          channelName,
          removed: false,
          alreadyRemoved: true,
          slackError: response.error
        });
      }

      throw normalizeSlackApiResponse(response, "Slack channel remove failed.", {
        channelId: channel.id,
        userId: user.id
      });
    }

    return toRemoveUserResult({
      userId: user.id,
      userEmail,
      channelId: channel.id,
      channelName,
      removed: true,
      alreadyRemoved: false
    });
  }
}

class FetchSlackWebApiClient implements SlackWebApiClient {
  constructor(private readonly botToken: string) {}

  lookupUserByEmail(input: { email: string }): Promise<SlackApiResponse<SlackUserResponse>> {
    return this.call("users.lookupByEmail", input);
  }

  listConversations(input: {
    cursor?: string;
    limit: number;
    types: string;
  }): Promise<SlackApiResponse<ConversationsListResponse>> {
    return this.call("conversations.list", input);
  }

  getConversationInfo(input: {
    channel: string;
  }): Promise<SlackApiResponse<ConversationInfoResponse>> {
    return this.call("conversations.info", input);
  }

  listConversationMembers(input: {
    channel: string;
    cursor?: string;
    limit: number;
  }): Promise<SlackApiResponse<ConversationMembersResponse>> {
    return this.call("conversations.members", input);
  }

  inviteToConversation(input: {
    channel: string;
    users: string;
  }): Promise<SlackApiResponse<ConversationInviteResponse>> {
    return this.call("conversations.invite", input);
  }

  kickFromConversation(input: {
    channel: string;
    user: string;
  }): Promise<SlackApiResponse<Record<string, unknown>>> {
    return this.call("conversations.kick", input);
  }

  private async call<T>(method: string, input: Record<string, string | number | undefined>): Promise<SlackApiResponse<T>> {
    const body = new URLSearchParams();

    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) {
        body.set(key, String(value));
      }
    }

    const response = await fetch(`${SLACK_API_BASE_URL}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (response.status === 429) {
      return {
        ok: false,
        error: "ratelimited",
        response_metadata: {},
        retry_after: response.headers.get("retry-after") ?? undefined
      } as SlackApiResponse<T> & { retry_after?: string };
    }

    const data = await response.json() as SlackApiResponse<T>;

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

function normalizeChannelName(channelName: string): string {
  return channelName.trim().replace(/^#+/u, "").toLowerCase();
}

function nextCursor(response: { response_metadata?: { next_cursor?: string } }): string | undefined {
  const cursor = response.response_metadata?.next_cursor?.trim();
  return cursor ? cursor : undefined;
}

function isSlackUserNotFound(error: string | undefined): boolean {
  return error === "users_not_found" || error === "user_not_found";
}

function toAddUserResult(input: {
  userId: string;
  userEmail: string;
  channelId: string;
  channelName: string;
  added: boolean;
  alreadyInChannel: boolean;
  slackError?: string;
}): AddUserToSlackChannelResult {
  return {
    provider: SLACK_PROVIDER,
    userId: input.userId,
    userEmail: input.userEmail,
    channelId: input.channelId,
    channelName: input.channelName,
    added: input.added,
    alreadyInChannel: input.alreadyInChannel,
    raw: toRedactedSlackRaw(input)
  };
}

function toRemoveUserResult(input: {
  userId: string | null;
  userEmail: string;
  channelId: string | null;
  channelName: string;
  removed: boolean;
  alreadyRemoved: boolean;
  warning?: string;
  slackError?: string;
}): RemoveUserFromSlackChannelResult {
  return {
    provider: SLACK_PROVIDER,
    operation: "remove_user_from_channel",
    userId: input.userId,
    userEmail: input.userEmail,
    channelId: input.channelId,
    channelName: input.channelName,
    removed: input.removed,
    alreadyRemoved: input.alreadyRemoved,
    warning: input.warning,
    raw: toRedactedSlackRaw({
      userId: input.userId ?? undefined,
      channelId: input.channelId ?? undefined,
      slackError: input.slackError
    })
  };
}

function toRedactedSlackRaw(input: {
  userId?: string;
  channelId?: string;
  slackError?: string;
}): Record<string, unknown> {
  return {
    userId: input.userId,
    channelId: input.channelId,
    ...(input.slackError ? { slackError: input.slackError } : {})
  };
}

function normalizeSlackApiResponse(
  response: {
    error?: string;
    needed?: string;
    provided?: string;
    statusCode?: number;
    retry_after?: string;
  },
  fallbackMessage: string,
  details: Record<string, unknown> = {}
): SlackConnectorError {
  const code = codeForSlackError(response.error);

  return new SlackConnectorError({
    code,
    message: messageForSlackError(response.error, fallbackMessage),
    statusCode: code === SLACK_CONNECTOR_ERROR_CODE.rateLimited ? 429 : response.statusCode,
    details: {
      ...details,
      slackError: response.error,
      needed: response.needed,
      provided: response.provided,
      retryAfter: response.retry_after
    }
  });
}

function codeForSlackError(error: string | undefined): SlackConnectorErrorCode {
  if (error === "not_authed" || error === "invalid_auth" || error === "account_inactive") {
    return SLACK_CONNECTOR_ERROR_CODE.authFailed;
  }

  if (error === "missing_scope") {
    return SLACK_CONNECTOR_ERROR_CODE.missingScope;
  }

  if (isSlackUserNotFound(error)) {
    return SLACK_CONNECTOR_ERROR_CODE.userNotFound;
  }

  if (error === "channel_not_found") {
    return SLACK_CONNECTOR_ERROR_CODE.channelNotFound;
  }

  if (error === "not_in_channel") {
    return SLACK_CONNECTOR_ERROR_CODE.botNotInChannel;
  }

  if (error === "already_in_channel") {
    return SLACK_CONNECTOR_ERROR_CODE.alreadyInChannel;
  }

  if (error === "ratelimited") {
    return SLACK_CONNECTOR_ERROR_CODE.rateLimited;
  }

  if (error) {
    return SLACK_CONNECTOR_ERROR_CODE.slackApiError;
  }

  return SLACK_CONNECTOR_ERROR_CODE.unknown;
}

function messageForSlackError(error: string | undefined, fallbackMessage: string): string {
  if (error === "missing_scope") {
    return "Slack token is missing a required scope.";
  }

  if (isSlackUserNotFound(error)) {
    return "Slack user was not found.";
  }

  if (error === "channel_not_found") {
    return "Slack channel was not found.";
  }

  if (error === "not_in_channel") {
    return "Slack bot or caller must be a member of the Slack channel before inviting users.";
  }

  if (error === "ratelimited") {
    return "Slack API rate limit exceeded.";
  }

  if (error === "not_authed" || error === "invalid_auth" || error === "account_inactive") {
    return "Slack authentication failed.";
  }

  return fallbackMessage;
}

import type { SlackConnectorInterface } from "./slack-connector.interface.js";
import {
  SLACK_PROVIDER,
  type AddUserToSlackChannelInput,
  type AddUserToSlackChannelResult,
  type FindSlackChannelByIdInput,
  type FindSlackChannelInput,
  type LookupSlackUserByEmailInput,
  type RemoveUserFromSlackChannelInput,
  type RemoveUserFromSlackChannelResult,
  type SlackChannel,
  type SlackUser
} from "./slack.types.js";

export class MockSlackConnector implements SlackConnectorInterface {
  async lookupUserByEmail(input: LookupSlackUserByEmailInput): Promise<SlackUser | null> {
    const email = normalizeEmail(input.email);

    return {
      id: createMockUserId(email),
      email,
      name: email,
      realName: email,
      deleted: false
    };
  }

  async findChannelByName(input: FindSlackChannelInput): Promise<SlackChannel | null> {
    const channelName = normalizeChannelName(input.channelName);

    return {
      id: createMockChannelId(channelName),
      name: channelName,
      isPrivate: false,
      isArchived: false
    };
  }

  async findChannelById(input: FindSlackChannelByIdInput): Promise<SlackChannel | null> {
    const channelId = input.channelId.trim();

    if (!channelId) {
      return null;
    }

    const channelName = channelId.startsWith("mock-slack-channel:")
      ? channelId.slice("mock-slack-channel:".length)
      : channelId.toLowerCase();

    return {
      id: channelId,
      name: normalizeChannelName(channelName),
      isPrivate: false,
      isArchived: false
    };
  }

  async isUserInChannel(_input: { userId: string; channelId: string }): Promise<boolean> {
    return false;
  }

  async addUserToChannel(input: AddUserToSlackChannelInput): Promise<AddUserToSlackChannelResult> {
    const userEmail = normalizeEmail(input.userEmail);
    const channelName = normalizeChannelName(input.channelName);

    return {
      provider: SLACK_PROVIDER,
      userId: createMockUserId(userEmail),
      userEmail,
      channelId: createMockChannelId(channelName),
      channelName,
      added: true,
      alreadyInChannel: false
    };
  }

  async removeUserFromChannel(input: RemoveUserFromSlackChannelInput): Promise<RemoveUserFromSlackChannelResult> {
    const userEmail = normalizeEmail(input.userEmail);
    const channelName = normalizeChannelName(input.channelName);

    return {
      provider: SLACK_PROVIDER,
      operation: "remove_user_from_channel",
      userId: createMockUserId(userEmail),
      userEmail,
      channelId: createMockChannelId(channelName),
      channelName,
      removed: true,
      alreadyRemoved: false
    };
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeChannelName(channelName: string): string {
  return channelName.trim().replace(/^#+/u, "").toLowerCase();
}

function createMockUserId(email: string): string {
  return `mock-slack-user:${email}`;
}

function createMockChannelId(channelName: string): string {
  return `mock-slack-channel:${channelName}`;
}

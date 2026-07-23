import { describe, expect, it, vi } from "vitest";

import { SlackConnector, type SlackWebApiClient } from "./slack.connector.js";
import { SLACK_CONNECTOR_ERROR_CODE, SlackConnectorError } from "./slack.types.js";

describe("SlackConnector", () => {
  it("adds a user to a Slack channel", async () => {
    const webClient = makeWebClient({
      lookupUserByEmail: vi.fn(async () => ({
        ok: true,
        user: {
          id: "U123",
          name: "riya",
          real_name: "Riya Sharma",
          profile: {
            email: "riya.sharma@company.com"
          },
          deleted: false
        }
      })),
      listConversations: vi.fn(async () => ({
        ok: true,
        channels: [
          {
            id: "C123",
            name: "backend-alerts",
            is_private: false,
            is_archived: false
          }
        ]
      })),
      listConversationMembers: vi.fn(async () => ({
        ok: true,
        members: []
      })),
      inviteToConversation: vi.fn(async () => ({
        ok: true,
        channel: {
          id: "C123",
          name: "backend-alerts"
        }
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.addUserToChannel({
      userEmail: " Riya.Sharma@Company.com ",
      channelName: " #Backend-Alerts "
    })).resolves.toEqual({
      provider: "slack",
      userId: "U123",
      userEmail: "riya.sharma@company.com",
      channelId: "C123",
      channelName: "backend-alerts",
      added: true,
      alreadyInChannel: false,
      raw: {
        userId: "U123",
        channelId: "C123"
      }
    });
    expect(webClient.inviteToConversation).toHaveBeenCalledWith({
      channel: "C123",
      users: "U123"
    });
  });

  it("treats existing channel membership as idempotent success", async () => {
    const webClient = makeWebClient({
      listConversationMembers: vi.fn(async () => ({
        ok: true,
        members: ["U123"]
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.addUserToChannel({
      userEmail: "riya.sharma@company.com",
      channelName: "backend-alerts"
    })).resolves.toMatchObject({
      added: false,
      alreadyInChannel: true
    });
    expect(webClient.inviteToConversation).not.toHaveBeenCalled();
  });

  it("treats already_in_channel from invite as idempotent success", async () => {
    const webClient = makeWebClient({
      inviteToConversation: vi.fn(async () => ({
        ok: false,
        error: "already_in_channel"
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.addUserToChannel({
      userEmail: "riya.sharma@company.com",
      channelName: "backend-alerts"
    })).resolves.toMatchObject({
      added: false,
      alreadyInChannel: true,
      raw: {
        userId: "U123",
        channelId: "C123",
        slackError: "already_in_channel"
      }
    });
  });

  it("respects conversations.list pagination when finding a channel", async () => {
    const webClient = makeWebClient({
      listConversations: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          channels: [{ id: "C000", name: "general" }],
          response_metadata: {
            next_cursor: "next-page"
          }
        })
        .mockResolvedValueOnce({
          ok: true,
          channels: [{ id: "C123", name: "backend-alerts", is_private: true }],
          response_metadata: {
            next_cursor: ""
          }
        })
    });
    const connector = makeConnector(webClient);

    await expect(connector.findChannelByName({
      channelName: "#backend-alerts"
    })).resolves.toEqual({
      id: "C123",
      name: "backend-alerts",
      isPrivate: true,
      isArchived: undefined
    });
    expect(webClient.listConversations).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      limit: 200,
      types: "public_channel,private_channel"
    });
    expect(webClient.listConversations).toHaveBeenNthCalledWith(2, {
      cursor: "next-page",
      limit: 200,
      types: "public_channel,private_channel"
    });
  });

  it("finds a Slack channel by id", async () => {
    const webClient = makeWebClient({
      getConversationInfo: vi.fn(async () => ({
        ok: true,
        channel: {
          id: "C082B4DK080",
          name: "engineering-team-1",
          is_private: false,
          is_archived: false
        }
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.findChannelById({
      channelId: " C082B4DK080 "
    })).resolves.toEqual({
      id: "C082B4DK080",
      name: "engineering-team-1",
      isPrivate: false,
      isArchived: false
    });
    expect(webClient.getConversationInfo).toHaveBeenCalledWith({
      channel: "C082B4DK080"
    });
  });

  it("returns null when a Slack channel id is not found", async () => {
    const webClient = makeWebClient({
      getConversationInfo: vi.fn(async () => ({
        ok: false,
        error: "channel_not_found"
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.findChannelById({
      channelId: "C_UNKNOWN"
    })).resolves.toBeNull();
  });

  it("throws slack_user_not_found when the email does not map to a Slack user", async () => {
    const webClient = makeWebClient({
      lookupUserByEmail: vi.fn(async () => ({
        ok: false,
        error: "users_not_found"
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.addUserToChannel({
      userEmail: "missing@company.com",
      channelName: "backend-alerts"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.userNotFound
    } satisfies Partial<SlackConnectorError>);
  });

  it("throws slack_channel_not_found when the channel cannot be found", async () => {
    const webClient = makeWebClient({
      listConversations: vi.fn(async () => ({
        ok: true,
        channels: []
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.addUserToChannel({
      userEmail: "riya.sharma@company.com",
      channelName: "missing-channel"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.channelNotFound
    } satisfies Partial<SlackConnectorError>);
  });

  it("normalizes missing scope errors with safe metadata", async () => {
    const webClient = makeWebClient({
      listConversations: vi.fn(async () => ({
        ok: false,
        error: "missing_scope",
        needed: "channels:read,groups:read",
        provided: "chat:write"
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.findChannelByName({
      channelName: "backend-alerts"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.missingScope,
      message: "Slack token is missing a required scope.",
      details: {
        slackError: "missing_scope",
        needed: "channels:read,groups:read",
        provided: "chat:write"
      }
    } satisfies Partial<SlackConnectorError>);
  });

  it("normalizes not_in_channel when the bot cannot invite to the channel", async () => {
    const webClient = makeWebClient({
      inviteToConversation: vi.fn(async () => ({
        ok: false,
        error: "not_in_channel"
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.addUserToChannel({
      userEmail: "riya.sharma@company.com",
      channelName: "backend-alerts"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.botNotInChannel,
      message: "Slack bot or caller must be a member of the Slack channel before inviting users."
    } satisfies Partial<SlackConnectorError>);
  });

  it("removes a Slack user from a channel", async () => {
    const webClient = makeWebClient({
      listConversationMembers: vi.fn(async () => ({
        ok: true,
        members: ["U123"]
      })),
      kickFromConversation: vi.fn(async () => ({
        ok: true
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.removeUserFromChannel({
      userEmail: "riya.sharma@company.com",
      channelName: "#backend-alerts"
    })).resolves.toMatchObject({
      provider: "slack",
      operation: "remove_user_from_channel",
      userId: "U123",
      userEmail: "riya.sharma@company.com",
      channelId: "C123",
      channelName: "backend-alerts",
      removed: true,
      alreadyRemoved: false
    });

    expect(webClient.kickFromConversation).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123"
    });
  });

  it("treats channel revoke as idempotent when the user is already absent", async () => {
    const webClient = makeWebClient({
      listConversationMembers: vi.fn(async () => ({
        ok: true,
        members: []
      }))
    });
    const connector = makeConnector(webClient);

    await expect(connector.removeUserFromChannel({
      userEmail: "riya.sharma@company.com",
      channelName: "backend-alerts"
    })).resolves.toMatchObject({
      removed: false,
      alreadyRemoved: true
    });

    expect(webClient.kickFromConversation).not.toHaveBeenCalled();
  });
});

function makeConnector(webClient: SlackWebApiClient): SlackConnector {
  return new SlackConnector({
    botToken: "xoxb-test-token",
    webClient
  });
}

function makeWebClient(overrides: Partial<SlackWebApiClient> = {}): SlackWebApiClient {
  return {
    lookupUserByEmail: vi.fn(async () => ({
      ok: true,
      user: {
        id: "U123",
        profile: {
          email: "riya.sharma@company.com"
        }
      }
    })),
    getConversationInfo: vi.fn(async () => ({
      ok: true,
      channel: {
        id: "C123",
        name: "backend-alerts"
      }
    })),
    listConversations: vi.fn(async () => ({
      ok: true,
      channels: [{
        id: "C123",
        name: "backend-alerts"
      }]
    })),
    listConversationMembers: vi.fn(async () => ({
      ok: true,
      members: []
    })),
    inviteToConversation: vi.fn(async () => ({
      ok: true,
      channel: {
        id: "C123",
        name: "backend-alerts"
      }
    })),
    kickFromConversation: vi.fn(async () => ({
      ok: true
    })),
    ...overrides
  };
}

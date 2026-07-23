import { describe, expect, it } from "vitest";

import { MockSlackConnector } from "./mock-slack.connector.js";
import { SLACK_PROVIDER } from "./slack.types.js";

describe("MockSlackConnector", () => {
  it("looks up a mock Slack user by normalized email", async () => {
    const connector = new MockSlackConnector();

    await expect(connector.lookupUserByEmail({
      email: " Riya.Sharma@Company.com "
    })).resolves.toEqual({
      id: "mock-slack-user:riya.sharma@company.com",
      email: "riya.sharma@company.com",
      name: "riya.sharma@company.com",
      realName: "riya.sharma@company.com",
      deleted: false
    });
  });

  it("finds a mock Slack channel by normalized name", async () => {
    const connector = new MockSlackConnector();

    await expect(connector.findChannelByName({
      channelName: " #Backend-Alerts "
    })).resolves.toEqual({
      id: "mock-slack-channel:backend-alerts",
      name: "backend-alerts",
      isPrivate: false,
      isArchived: false
    });
  });

  it("returns false for channel membership by default", async () => {
    const connector = new MockSlackConnector();

    await expect(connector.isUserInChannel({
      userId: "mock-slack-user:riya.sharma@company.com",
      channelId: "mock-slack-channel:backend-alerts"
    })).resolves.toBe(false);
  });

  it("adds a mock user to a mock channel", async () => {
    const connector = new MockSlackConnector();

    await expect(connector.addUserToChannel({
      userEmail: " Riya.Sharma@Company.com ",
      channelName: " #Backend-Alerts "
    })).resolves.toEqual({
      provider: SLACK_PROVIDER,
      userId: "mock-slack-user:riya.sharma@company.com",
      userEmail: "riya.sharma@company.com",
      channelId: "mock-slack-channel:backend-alerts",
      channelName: "backend-alerts",
      added: true,
      alreadyInChannel: false
    });
  });
});


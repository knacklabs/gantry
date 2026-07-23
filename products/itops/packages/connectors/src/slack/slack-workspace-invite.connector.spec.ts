import { describe, expect, it, vi } from "vitest";

import {
  SlackWorkspaceInviteConnector,
  type SlackAdminUsersClient
} from "./slack-workspace-invite.connector.js";
import { SLACK_CONNECTOR_ERROR_CODE, SlackConnectorError } from "./slack.types.js";

describe("SlackWorkspaceInviteConnector", () => {
  it("invites a user to the Slack workspace", async () => {
    const adminClient = makeAdminClient({
      invite: vi.fn(async () => ({
        ok: true,
        user: {
          id: "U123"
        }
      }))
    });
    const connector = makeConnector(adminClient);

    await expect(connector.inviteUserToWorkspace({
      email: " Riya.Sharma@Company.com ",
      fullName: "Riya Sharma"
    })).resolves.toEqual({
      provider: "slack",
      email: "riya.sharma@company.com",
      invited: true,
      alreadyInWorkspace: false,
      alreadyInvited: false,
      userId: "U123",
      teamId: "T123",
      channelIds: ["C123"],
      raw: {
        userId: "U123",
        teamId: "T123",
        channelIds: ["C123"]
      }
    });
    expect(adminClient.invite).toHaveBeenCalledWith({
      email: "riya.sharma@company.com",
      realName: "Riya Sharma",
      channelIds: ["C123"],
      teamId: "T123"
    });
  });

  it("treats already invited as idempotent success", async () => {
    const adminClient = makeAdminClient({
      invite: vi.fn(async () => ({
        ok: false,
        error: "already_invited"
      }))
    });
    const connector = makeConnector(adminClient);

    await expect(connector.inviteUserToWorkspace({
      email: "riya.sharma@company.com"
    })).resolves.toMatchObject({
      provider: "slack",
      email: "riya.sharma@company.com",
      invited: false,
      alreadyInvited: true,
      alreadyInWorkspace: false,
      raw: {
        slackError: "already_invited"
      }
    });
  });

  it("treats already in workspace as idempotent success", async () => {
    const adminClient = makeAdminClient({
      invite: vi.fn(async () => ({
        ok: false,
        error: "already_in_team",
        user: {
          id: "U123"
        }
      }))
    });
    const connector = makeConnector(adminClient);

    await expect(connector.inviteUserToWorkspace({
      email: "riya.sharma@company.com"
    })).resolves.toMatchObject({
      invited: false,
      alreadyInvited: false,
      alreadyInWorkspace: true,
      userId: "U123",
      raw: {
        slackError: "already_in_team"
      }
    });
  });

  it("normalizes missing scope errors", async () => {
    const adminClient = makeAdminClient({
      invite: vi.fn(async () => ({
        ok: false,
        error: "missing_scope",
        needed: "admin.users:write",
        provided: "users:read"
      }))
    });
    const connector = makeConnector(adminClient);

    await expect(connector.inviteUserToWorkspace({
      email: "riya.sharma@company.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.missingScope,
      message: "Slack admin token is missing a required scope.",
      details: {
        slackError: "missing_scope",
        needed: "admin.users:write",
        provided: "users:read"
      }
    } satisfies Partial<SlackConnectorError>);
  });
});

function makeConnector(adminClient: SlackAdminUsersClient): SlackWorkspaceInviteConnector {
  return new SlackWorkspaceInviteConnector({
    adminToken: "xoxp-admin-token",
    teamId: "T123",
    defaultChannelIds: ["C123"],
    adminClient
  });
}

function makeAdminClient(overrides: Partial<SlackAdminUsersClient> = {}): SlackAdminUsersClient {
  return {
    invite: vi.fn(async () => ({
      ok: true,
      user: {
        id: "U123"
      }
    })),
    ...overrides
  };
}

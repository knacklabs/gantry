import type { SlackWorkspaceInviteConnectorInterface } from "./slack-workspace-invite-connector.interface.js";
import {
  SLACK_PROVIDER,
  type InviteSlackUserToWorkspaceInput,
  type SlackWorkspaceInviteResult
} from "./slack.types.js";

export class MockSlackWorkspaceInviteConnector implements SlackWorkspaceInviteConnectorInterface {
  async inviteUserToWorkspace(input: InviteSlackUserToWorkspaceInput): Promise<SlackWorkspaceInviteResult> {
    const email = input.email.trim().toLowerCase();

    return {
      provider: SLACK_PROVIDER,
      email,
      invited: true,
      alreadyInWorkspace: false,
      alreadyInvited: false,
      userId: `mock-slack-user:${email}`,
      channelIds: input.channelIds ?? [],
      raw: {
        userId: `mock-slack-user:${email}`
      }
    };
  }
}

import type {
  InviteSlackUserToWorkspaceInput,
  SlackWorkspaceInviteResult
} from "./slack.types.js";

export interface SlackWorkspaceInviteConnectorInterface {
  inviteUserToWorkspace(input: InviteSlackUserToWorkspaceInput): Promise<SlackWorkspaceInviteResult>;
}

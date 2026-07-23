import type {
  AddUserToSlackChannelInput,
  AddUserToSlackChannelResult,
  FindSlackChannelByIdInput,
  FindSlackChannelInput,
  LookupSlackUserByEmailInput,
  RemoveUserFromSlackChannelInput,
  RemoveUserFromSlackChannelResult,
  SlackChannel,
  SlackUser
} from "./slack.types.js";

export interface SlackConnectorInterface {
  lookupUserByEmail(input: LookupSlackUserByEmailInput): Promise<SlackUser | null>;
  findChannelByName(input: FindSlackChannelInput): Promise<SlackChannel | null>;
  findChannelById(input: FindSlackChannelByIdInput): Promise<SlackChannel | null>;
  isUserInChannel(input: { userId: string; channelId: string }): Promise<boolean>;
  addUserToChannel(input: AddUserToSlackChannelInput): Promise<AddUserToSlackChannelResult>;
  removeUserFromChannel(input: RemoveUserFromSlackChannelInput): Promise<RemoveUserFromSlackChannelResult>;
}

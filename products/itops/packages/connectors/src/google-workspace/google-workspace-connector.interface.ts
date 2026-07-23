import type {
  CreateGoogleWorkspaceUserInput,
  CreateGoogleWorkspaceUserResult,
  GetGoogleWorkspaceUserResult,
  SuspendGoogleWorkspaceUserInput,
  SuspendGoogleWorkspaceUserResult
} from "./google-workspace.types.js";

export interface GoogleWorkspaceConnectorInterface {
  createUser(input: CreateGoogleWorkspaceUserInput): Promise<CreateGoogleWorkspaceUserResult>;
  getUserByEmail(email: string): Promise<GetGoogleWorkspaceUserResult | null>;
  suspendUser(input: SuspendGoogleWorkspaceUserInput): Promise<SuspendGoogleWorkspaceUserResult>;
}

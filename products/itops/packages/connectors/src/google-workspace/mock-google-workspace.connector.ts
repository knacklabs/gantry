import type { GoogleWorkspaceConnectorInterface } from "./google-workspace-connector.interface.js";
import {
  GOOGLE_WORKSPACE_PROVIDER,
  type CreateGoogleWorkspaceUserInput,
  type CreateGoogleWorkspaceUserResult,
  type GetGoogleWorkspaceUserResult,
  type SuspendGoogleWorkspaceUserInput,
  type SuspendGoogleWorkspaceUserResult
} from "./google-workspace.types.js";

export class MockGoogleWorkspaceConnector implements GoogleWorkspaceConnectorInterface {
  async createUser(input: CreateGoogleWorkspaceUserInput): Promise<CreateGoogleWorkspaceUserResult> {
    const primaryEmail = normalizeEmail(input.primaryEmail);

    return {
      provider: GOOGLE_WORKSPACE_PROVIDER,
      externalUserId: createMockExternalUserId(primaryEmail),
      primaryEmail,
      created: true,
      alreadyExisted: false,
      temporaryPassword: input.password ?? "mock-temporary-password"
    };
  }

  async getUserByEmail(_email: string): Promise<GetGoogleWorkspaceUserResult | null> {
    return null;
  }

  async suspendUser(input: SuspendGoogleWorkspaceUserInput): Promise<SuspendGoogleWorkspaceUserResult> {
    const primaryEmail = normalizeEmail(input.primaryEmail);

    return {
      provider: GOOGLE_WORKSPACE_PROVIDER,
      externalUserId: createMockExternalUserId(primaryEmail),
      primaryEmail,
      suspended: true,
      alreadySuspended: false,
      alreadyMissing: false
    };
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function createMockExternalUserId(primaryEmail: string): string {
  return `mock-google-workspace:${primaryEmail}`;
}

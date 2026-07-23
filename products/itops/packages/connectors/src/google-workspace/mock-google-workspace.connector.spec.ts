import { describe, expect, it } from "vitest";

import { GOOGLE_WORKSPACE_PROVIDER } from "./google-workspace.types.js";
import { MockGoogleWorkspaceConnector } from "./mock-google-workspace.connector.js";

describe("MockGoogleWorkspaceConnector", () => {
  it("creates a mock Google Workspace user", async () => {
    const connector = new MockGoogleWorkspaceConnector();

    await expect(
      connector.createUser({
        primaryEmail: " Riya.Sharma@Company.com ",
        fullName: "Riya Sharma",
        givenName: "Riya",
        familyName: "Sharma",
        personalEmail: "riya.personal@example.com"
      })
    ).resolves.toEqual({
      provider: GOOGLE_WORKSPACE_PROVIDER,
      externalUserId: "mock-google-workspace:riya.sharma@company.com",
      primaryEmail: "riya.sharma@company.com",
      created: true,
      alreadyExisted: false,
      temporaryPassword: "mock-temporary-password"
    });
  });

  it("returns null for getUserByEmail by default", async () => {
    const connector = new MockGoogleWorkspaceConnector();

    await expect(connector.getUserByEmail("riya.sharma@company.com")).resolves.toBeNull();
  });

  it("stubs user suspension", async () => {
    const connector = new MockGoogleWorkspaceConnector();

    await expect(
      connector.suspendUser({
        primaryEmail: " Riya.Sharma@Company.com "
      })
    ).resolves.toEqual({
      provider: GOOGLE_WORKSPACE_PROVIDER,
      externalUserId: "mock-google-workspace:riya.sharma@company.com",
      primaryEmail: "riya.sharma@company.com",
      suspended: true,
      alreadySuspended: false,
      alreadyMissing: false
    });
  });
});

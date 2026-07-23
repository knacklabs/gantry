import { describe, expect, it, vi } from "vitest";

import { GoogleWorkspaceConnector } from "./google-workspace.connector.js";
import { GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE, GoogleWorkspaceConnectorError } from "./google-workspace.types.js";

describe("GoogleWorkspaceConnector", () => {
  it("returns an existing user instead of creating a duplicate", async () => {
    const usersClient = makeUsersClient({
      get: vi.fn(async () => googleResponse({
        id: "google-user-1",
        primaryEmail: "riya.sharma@company.com",
        name: {
          fullName: "Riya Sharma",
          givenName: "Riya",
          familyName: "Sharma"
        }
      }))
    });
    const connector = makeConnector(usersClient);

    await expect(connector.createUser(makeCreateUserInput())).resolves.toEqual({
      provider: "google_workspace",
      externalUserId: "google-user-1",
      primaryEmail: "riya.sharma@company.com",
      created: false,
      alreadyExisted: true,
      raw: {
        id: "google-user-1",
        primaryEmail: "riya.sharma@company.com",
        name: {
          fullName: "Riya Sharma",
          givenName: "Riya",
          familyName: "Sharma"
        },
        suspended: undefined
      }
    });
    expect(usersClient.get).toHaveBeenCalledWith({
      userKey: "riya.sharma@company.com"
    });
    expect(usersClient.insert).not.toHaveBeenCalled();
  });

  it("creates a missing user and returns the temporary password for in-memory delivery", async () => {
    const usersClient = makeUsersClient({
      get: vi.fn(async () => {
        throw googleError(404, "Resource Not Found");
      }),
      insert: vi.fn(async () => googleResponse({
        id: "google-user-2",
        primaryEmail: "riya.sharma@company.com",
        name: {
          fullName: "Riya Sharma",
          givenName: "Riya",
          familyName: "Sharma"
        }
      }))
    });
    const connector = makeConnector(usersClient);

    const result = await connector.createUser(makeCreateUserInput());

    expect(result).toEqual({
      provider: "google_workspace",
      externalUserId: "google-user-2",
      primaryEmail: "riya.sharma@company.com",
      created: true,
      alreadyExisted: false,
      temporaryPassword: expect.any(String),
      raw: {
        id: "google-user-2",
        primaryEmail: "riya.sharma@company.com",
        name: {
          fullName: "Riya Sharma",
          givenName: "Riya",
          familyName: "Sharma"
        },
        suspended: undefined
      }
    });

    expect(usersClient.insert).toHaveBeenCalledWith({
      requestBody: expect.objectContaining({
        primaryEmail: "riya.sharma@company.com",
        changePasswordAtNextLogin: true,
        recoveryEmail: "riya.personal@example.com",
        password: expect.any(String)
      })
    });
    const insertRequest = vi.mocked(usersClient.insert).mock.calls[0]![0] as {
      requestBody: { password: string };
    };
    expect(result.temporaryPassword).toBe(insertRequest.requestBody.password);
    expect(JSON.stringify(result.raw)).not.toContain(insertRequest.requestBody.password);
  });

  it("returns null when getUserByEmail receives a Google 404", async () => {
    const usersClient = makeUsersClient({
      get: vi.fn(async () => {
        throw googleError(404, "Resource Not Found");
      })
    });
    const connector = makeConnector(usersClient);

    await expect(connector.getUserByEmail("riya.sharma@company.com")).resolves.toBeNull();
  });

  it("handles duplicate create races idempotently", async () => {
    const usersClient = makeUsersClient({
      get: vi
        .fn()
        .mockRejectedValueOnce(googleError(404, "Resource Not Found"))
        .mockResolvedValueOnce(googleResponse({
          id: "google-user-3",
          primaryEmail: "riya.sharma@company.com"
        })),
      insert: vi.fn(async () => {
        throw googleError(409, "Entity already exists");
      })
    });
    const connector = makeConnector(usersClient);

    await expect(connector.createUser(makeCreateUserInput())).resolves.toMatchObject({
      externalUserId: "google-user-3",
      primaryEmail: "riya.sharma@company.com",
      created: false,
      alreadyExisted: true
    });
  });

  it("suspends an active user", async () => {
    const usersClient = makeUsersClient({
      get: vi.fn(async () => googleResponse({
        id: "google-user-4",
        primaryEmail: "riya.sharma@company.com",
        suspended: false
      })),
      patch: vi.fn(async () => googleResponse({
        id: "google-user-4",
        primaryEmail: "riya.sharma@company.com",
        suspended: true
      }))
    });
    const connector = makeConnector(usersClient);

    await expect(connector.suspendUser({ primaryEmail: " Riya.Sharma@Company.com " })).resolves.toEqual({
      provider: "google_workspace",
      externalUserId: "google-user-4",
      primaryEmail: "riya.sharma@company.com",
      suspended: true,
      alreadySuspended: false,
      alreadyMissing: false,
      raw: {
        id: "google-user-4",
        primaryEmail: "riya.sharma@company.com",
        name: undefined,
        suspended: true
      }
    });
    expect(usersClient.patch).toHaveBeenCalledWith({
      userKey: "riya.sharma@company.com",
      requestBody: {
        suspended: true
      }
    });
  });

  it("treats an already suspended user as idempotent success", async () => {
    const usersClient = makeUsersClient({
      get: vi.fn(async () => googleResponse({
        id: "google-user-5",
        primaryEmail: "riya.sharma@company.com",
        suspended: true
      }))
    });
    const connector = makeConnector(usersClient);

    await expect(connector.suspendUser({ primaryEmail: "riya.sharma@company.com" })).resolves.toEqual({
      provider: "google_workspace",
      externalUserId: "google-user-5",
      primaryEmail: "riya.sharma@company.com",
      suspended: true,
      alreadySuspended: true,
      raw: {
        id: "google-user-5",
        primaryEmail: "riya.sharma@company.com",
        name: undefined,
        suspended: true
      }
    });
    expect(usersClient.patch).not.toHaveBeenCalled();
  });

  it("treats a missing user as MVP revoke success", async () => {
    const usersClient = makeUsersClient({
      get: vi.fn(async () => {
        throw googleError(404, "Resource Not Found");
      })
    });
    const connector = makeConnector(usersClient);

    await expect(connector.suspendUser({ primaryEmail: "riya.sharma@company.com" })).resolves.toEqual({
      provider: "google_workspace",
      externalUserId: "missing:riya.sharma@company.com",
      primaryEmail: "riya.sharma@company.com",
      suspended: true,
      alreadyMissing: true
    });
    expect(usersClient.patch).not.toHaveBeenCalled();
  });

  it("treats a user missing during suspend patch as MVP revoke success", async () => {
    const usersClient = makeUsersClient({
      get: vi.fn(async () => googleResponse({
        id: "google-user-6",
        primaryEmail: "riya.sharma@company.com",
        suspended: false
      })),
      patch: vi.fn(async () => {
        throw googleError(404, "Resource Not Found");
      })
    });
    const connector = makeConnector(usersClient);

    await expect(connector.suspendUser({ primaryEmail: "riya.sharma@company.com" })).resolves.toEqual({
      provider: "google_workspace",
      externalUserId: "missing:riya.sharma@company.com",
      primaryEmail: "riya.sharma@company.com",
      suspended: true,
      alreadyMissing: true
    });
  });

  it.each([
    [401, GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.authFailed],
    [403, GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.permissionDenied],
    [429, GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.rateLimited],
    [500, GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.googleApiError]
  ])("normalizes Google status %s", async (status, code) => {
    const usersClient = makeUsersClient({
      get: vi.fn(async () => {
        throw googleError(status, "Google failed");
      })
    });
    const connector = makeConnector(usersClient);

    await expect(connector.getUserByEmail("riya.sharma@company.com")).rejects.toMatchObject({
      name: "GoogleWorkspaceConnectorError",
      code,
      statusCode: status,
      message: "Google failed"
    } satisfies Partial<GoogleWorkspaceConnectorError>);
  });
});

type UsersClientMock = {
  get: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

function makeConnector(usersClient: UsersClientMock): GoogleWorkspaceConnector {
  return new GoogleWorkspaceConnector({
    adminEmail: "admin@company.com",
    clientEmail: "service-account@project.iam.gserviceaccount.com",
    privateKey: "private-key",
    usersClient: usersClient as never
  });
}

function makeUsersClient(overrides: Partial<UsersClientMock> = {}): UsersClientMock {
  return {
    get: vi.fn(),
    insert: vi.fn(),
    patch: vi.fn(),
    ...overrides
  };
}

function makeCreateUserInput() {
  return {
    primaryEmail: "Riya.Sharma@Company.com",
    fullName: "Riya Sharma",
    givenName: "Riya",
    familyName: "Sharma",
    personalEmail: "riya.personal@example.com"
  };
}

function googleResponse(data: unknown) {
  return {
    data
  };
}

function googleError(status: number, message: string): Error & {
  code: number;
  response: {
    status: number;
    data: {
      error: {
        code: number;
        message: string;
        status: string;
      };
    };
  };
} {
  const error = new Error(message) as Error & {
    code: number;
    response: {
      status: number;
      data: {
        error: {
          code: number;
          message: string;
          status: string;
        };
      };
    };
  };
  error.code = status;
  error.response = {
    status,
    data: {
      error: {
        code: status,
        message,
        status: "GOOGLE_ERROR"
      }
    }
  };

  return error;
}

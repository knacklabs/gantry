import { randomInt } from "node:crypto";

import { google, type admin_directory_v1 } from "googleapis";

import type { GoogleWorkspaceConnectorInterface } from "./google-workspace-connector.interface.js";
import {
  GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE,
  GOOGLE_WORKSPACE_PROVIDER,
  GoogleWorkspaceConnectorError,
  type CreateGoogleWorkspaceUserInput,
  type CreateGoogleWorkspaceUserResult,
  type GetGoogleWorkspaceUserResult,
  type GoogleWorkspaceConnectorErrorCode,
  type SuspendGoogleWorkspaceUserInput,
  type SuspendGoogleWorkspaceUserResult
} from "./google-workspace.types.js";

const DIRECTORY_USER_SCOPE = "https://www.googleapis.com/auth/admin.directory.user";

type DirectoryUsersClient = Pick<admin_directory_v1.Resource$Users, "get" | "insert" | "patch">;

export type GoogleWorkspaceConnectorConfig = {
  adminEmail: string;
  clientEmail: string;
  privateKey: string;
  usersClient?: DirectoryUsersClient;
};

type GoogleApiErrorResponse = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{
      reason?: string;
      message?: string;
    }>;
  } | string;
  error_description?: string;
};

type GoogleApiErrorLike = {
  code?: number;
  message?: string;
  response?: {
    status?: number;
    data?: GoogleApiErrorResponse;
  };
};

export class GoogleWorkspaceConnector implements GoogleWorkspaceConnectorInterface {
  private readonly usersClient: DirectoryUsersClient;

  constructor(config: GoogleWorkspaceConnectorConfig) {
    this.usersClient = config.usersClient ?? createDirectoryUsersClient(config);
  }

  async getUserByEmail(email: string): Promise<GetGoogleWorkspaceUserResult | null> {
    const primaryEmail = normalizeEmail(email);

    try {
      const response = await this.usersClient.get({
        userKey: primaryEmail
      });

      return toGetUserResult(response.data, primaryEmail);
    } catch (error) {
      if (getGoogleStatusCode(error) === 404) {
        return null;
      }

      throw normalizeGoogleApiError(error);
    }
  }

  async createUser(input: CreateGoogleWorkspaceUserInput): Promise<CreateGoogleWorkspaceUserResult> {
    const primaryEmail = normalizeEmail(input.primaryEmail);
    const existingUser = await this.getUserByEmail(primaryEmail);

    if (existingUser) {
      return {
        provider: GOOGLE_WORKSPACE_PROVIDER,
        externalUserId: existingUser.externalUserId,
        primaryEmail: existingUser.primaryEmail,
        created: false,
        alreadyExisted: true,
        raw: existingUser.raw
      };
    }

    const temporaryPassword = input.password ?? generateTemporaryPassword();

    try {
      const response = await this.usersClient.insert({
        requestBody: {
          primaryEmail,
          name: {
            givenName: input.givenName,
            familyName: input.familyName,
            fullName: input.fullName
          },
          password: temporaryPassword,
          changePasswordAtNextLogin: true,
          ...(input.personalEmail ? { recoveryEmail: input.personalEmail } : {}),
          ...(input.orgUnitPath ? { orgUnitPath: input.orgUnitPath } : {})
        }
      });

      return {
        provider: GOOGLE_WORKSPACE_PROVIDER,
        externalUserId: requireGoogleUserId(response.data),
        primaryEmail: normalizeEmail(response.data.primaryEmail ?? primaryEmail),
        created: true,
        alreadyExisted: false,
        temporaryPassword,
        raw: toRedactedUserRaw(response.data)
      };
    } catch (error) {
      const connectorError = normalizeGoogleApiError(error);

      if (connectorError.code === GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.userAlreadyExists) {
        const user = await this.getUserByEmail(primaryEmail);

        if (user) {
          return {
            provider: GOOGLE_WORKSPACE_PROVIDER,
            externalUserId: user.externalUserId,
            primaryEmail: user.primaryEmail,
            created: false,
            alreadyExisted: true,
            raw: user.raw
          };
        }
      }

      throw connectorError;
    }
  }

  async suspendUser(input: SuspendGoogleWorkspaceUserInput): Promise<SuspendGoogleWorkspaceUserResult> {
    const primaryEmail = normalizeEmail(input.primaryEmail);
    const existingUser = await this.getUserByEmail(primaryEmail);

    if (!existingUser) {
      return {
        provider: GOOGLE_WORKSPACE_PROVIDER,
        externalUserId: `missing:${primaryEmail}`,
        primaryEmail,
        suspended: true,
        alreadyMissing: true
      };
    }

    if (existingUser.suspended) {
      return {
        provider: GOOGLE_WORKSPACE_PROVIDER,
        externalUserId: existingUser.externalUserId,
        primaryEmail: existingUser.primaryEmail,
        suspended: true,
        alreadySuspended: true,
        raw: existingUser.raw
      };
    }

    try {
      const response = await this.usersClient.patch({
        userKey: primaryEmail,
        requestBody: {
          suspended: true
        }
      });

      return {
        provider: GOOGLE_WORKSPACE_PROVIDER,
        externalUserId: requireGoogleUserId(response.data),
        primaryEmail: normalizeEmail(response.data.primaryEmail ?? primaryEmail),
        suspended: response.data.suspended ?? true,
        alreadySuspended: false,
        alreadyMissing: false,
        raw: toRedactedUserRaw(response.data)
      };
    } catch (error) {
      if (getGoogleStatusCode(error) === 404) {
        return {
          provider: GOOGLE_WORKSPACE_PROVIDER,
          externalUserId: `missing:${primaryEmail}`,
          primaryEmail,
          suspended: true,
          alreadyMissing: true
        };
      }

      throw normalizeGoogleApiError(error);
    }
  }
}

function createDirectoryUsersClient(config: GoogleWorkspaceConnectorConfig): DirectoryUsersClient {
  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key: config.privateKey,
    subject: config.adminEmail,
    scopes: [DIRECTORY_USER_SCOPE]
  });
  const directory = google.admin({
    version: "directory_v1",
    auth
  });

  return directory.users;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toGetUserResult(
  user: admin_directory_v1.Schema$User,
  fallbackEmail: string
): GetGoogleWorkspaceUserResult {
  return {
    provider: GOOGLE_WORKSPACE_PROVIDER,
    externalUserId: requireGoogleUserId(user),
    primaryEmail: normalizeEmail(user.primaryEmail ?? fallbackEmail),
    fullName: user.name?.fullName ?? undefined,
    givenName: user.name?.givenName ?? undefined,
    familyName: user.name?.familyName ?? undefined,
    suspended: user.suspended ?? undefined,
    raw: toRedactedUserRaw(user)
  };
}

function requireGoogleUserId(user: admin_directory_v1.Schema$User): string {
  if (!user.id) {
    throw new GoogleWorkspaceConnectorError({
      code: GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.googleApiError,
      message: "Google Workspace user response did not include an id."
    });
  }

  return user.id;
}

function toRedactedUserRaw(user: admin_directory_v1.Schema$User): Record<string, unknown> {
  return {
    id: user.id,
    primaryEmail: user.primaryEmail,
    name: user.name,
    suspended: user.suspended
  };
}

function normalizeGoogleApiError(error: unknown): GoogleWorkspaceConnectorError {
  if (error instanceof GoogleWorkspaceConnectorError) {
    return error;
  }

  const statusCode = getGoogleStatusCode(error);
  const body = getGoogleErrorBody(error);

  return new GoogleWorkspaceConnectorError({
    code: codeForStatus(statusCode),
    message: extractGoogleErrorMessage(body, error) ?? defaultMessageForStatus(statusCode),
    statusCode,
    details: extractRedactedErrorDetails(body)
  });
}

function getGoogleStatusCode(error: unknown): number | undefined {
  const googleError = error as GoogleApiErrorLike;
  return googleError.response?.status ?? googleError.code;
}

function getGoogleErrorBody(error: unknown): GoogleApiErrorResponse | undefined {
  const googleError = error as GoogleApiErrorLike;
  return googleError.response?.data;
}

function codeForStatus(status: number | undefined): GoogleWorkspaceConnectorErrorCode {
  if (status === 401) {
    return GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.authFailed;
  }

  if (status === 403) {
    return GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.permissionDenied;
  }

  if (status === 409) {
    return GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.userAlreadyExists;
  }

  if (status === 429) {
    return GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.rateLimited;
  }

  if (status) {
    return GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.googleApiError;
  }

  return GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.unknown;
}

function defaultMessageForStatus(status: number | undefined): string {
  if (status === 401) {
    return "Google Workspace authentication failed.";
  }

  if (status === 403) {
    return "Google Workspace permission denied.";
  }

  if (status === 409) {
    return "Google Workspace user already exists.";
  }

  if (status === 429) {
    return "Google Workspace rate limit exceeded.";
  }

  if (status) {
    return "Google Workspace API request failed.";
  }

  return "Google Workspace connector failed.";
}

function extractGoogleErrorMessage(body: GoogleApiErrorResponse | undefined, error: unknown): string | undefined {
  if (body) {
    if (typeof body.error === "string") {
      return body.error_description ?? body.error;
    }

    return body.error?.message ?? body.error_description;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return undefined;
}

function extractRedactedErrorDetails(body: GoogleApiErrorResponse | undefined): Record<string, unknown> | undefined {
  if (!body || typeof body.error === "string") {
    return undefined;
  }

  return {
    status: body.error?.status,
    reasons: body.error?.errors?.map((error) => error.reason).filter(Boolean)
  };
}

function generateTemporaryPassword(): string {
  const requiredCharacters = [
    randomCharacter("ABCDEFGHJKLMNPQRSTUVWXYZ"),
    randomCharacter("abcdefghijkmnopqrstuvwxyz"),
    randomCharacter("23456789"),
    randomCharacter("!@#$%^&*()-_=+")
  ];
  const allCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+";

  while (requiredCharacters.length < 24) {
    requiredCharacters.push(randomCharacter(allCharacters));
  }

  return shuffle(requiredCharacters).join("");
}

function randomCharacter(characters: string): string {
  return characters[randomInt(0, characters.length)]!;
}

function shuffle(values: string[]): string[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex]!, values[index]!];
  }

  return values;
}

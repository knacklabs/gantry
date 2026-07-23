export const GOOGLE_WORKSPACE_PROVIDER = "google_workspace" as const;

export type GoogleWorkspaceProvider = typeof GOOGLE_WORKSPACE_PROVIDER;

export type CreateGoogleWorkspaceUserInput = {
  primaryEmail: string;
  fullName: string;
  givenName: string;
  familyName: string;
  personalEmail?: string;
  password?: string;
  orgUnitPath?: string;
};

export type CreateGoogleWorkspaceUserResult = {
  provider: GoogleWorkspaceProvider;
  externalUserId: string;
  primaryEmail: string;
  created: boolean;
  alreadyExisted: boolean;
  temporaryPassword?: string;
  raw?: Record<string, unknown>;
};

export type GetGoogleWorkspaceUserResult = {
  provider: GoogleWorkspaceProvider;
  externalUserId: string;
  primaryEmail: string;
  fullName?: string;
  givenName?: string;
  familyName?: string;
  suspended?: boolean;
  raw?: Record<string, unknown>;
};

export type SuspendGoogleWorkspaceUserInput = {
  primaryEmail: string;
};

export type SuspendGoogleWorkspaceUserResult = {
  provider: GoogleWorkspaceProvider;
  externalUserId: string;
  primaryEmail: string;
  suspended: boolean;
  alreadySuspended?: boolean;
  alreadyMissing?: boolean;
  raw?: Record<string, unknown>;
};

export const GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE = {
  authFailed: "auth_failed",
  permissionDenied: "permission_denied",
  userAlreadyExists: "user_already_exists",
  rateLimited: "rate_limited",
  googleApiError: "google_api_error",
  unknown: "unknown"
} as const;

export type GoogleWorkspaceConnectorErrorCode =
  (typeof GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE)[keyof typeof GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE];

export type GoogleWorkspaceConnectorErrorResult = {
  provider: GoogleWorkspaceProvider;
  ok: false;
  code: GoogleWorkspaceConnectorErrorCode;
  message: string;
  statusCode?: number;
  details?: Record<string, unknown>;
};

export class GoogleWorkspaceConnectorError extends Error {
  readonly code: GoogleWorkspaceConnectorErrorCode;
  readonly statusCode?: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: GoogleWorkspaceConnectorErrorCode;
    message: string;
    statusCode?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "GoogleWorkspaceConnectorError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.details = input.details;
  }

  toResult(): GoogleWorkspaceConnectorErrorResult {
    return {
      provider: GOOGLE_WORKSPACE_PROVIDER,
      ok: false,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details
    };
  }
}

export function normalizeGoogleWorkspaceConnectorError(error: unknown): GoogleWorkspaceConnectorError {
  if (error instanceof GoogleWorkspaceConnectorError) {
    return error;
  }

  return new GoogleWorkspaceConnectorError({
    code: GOOGLE_WORKSPACE_CONNECTOR_ERROR_CODE.unknown,
    message: "Google Workspace connector failed.",
    cause: error
  });
}

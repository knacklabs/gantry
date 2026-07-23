import { google, type gmail_v1 } from "googleapis";

import { EMAIL_PROVIDER, type EmailProvider, type SendEmailInput, type SendEmailResult } from "../email.types.js";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

type GmailMessagesClient = Pick<gmail_v1.Resource$Users$Messages, "send">;

export const GMAIL_EMAIL_ERROR_CODE = {
  authFailed: "gmail_auth_failed",
  permissionDenied: "gmail_permission_denied",
  sendFailed: "gmail_send_failed",
  rateLimited: "gmail_rate_limited",
  unknown: "gmail_unknown_error"
} as const;

export type GmailEmailErrorCode = (typeof GMAIL_EMAIL_ERROR_CODE)[keyof typeof GMAIL_EMAIL_ERROR_CODE];

export class GmailEmailProviderError extends Error {
  readonly code: GmailEmailErrorCode;
  readonly statusCode?: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: GmailEmailErrorCode;
    message: string;
    statusCode?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "GmailEmailProviderError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.details = input.details;
  }

  toSafeResult(): Record<string, unknown> {
    return {
      provider: EMAIL_PROVIDER.gmail,
      ok: false,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details
    };
  }
}

export type GmailEmailProviderConfig = {
  clientEmail: string;
  privateKey: string;
  impersonatedEmail: string;
  messagesClient?: GmailMessagesClient;
};

export class GmailEmailProvider implements EmailProvider {
  private readonly messagesClient: GmailMessagesClient;

  constructor(config: GmailEmailProviderConfig) {
    this.messagesClient = config.messagesClient ?? createGmailMessagesClient(config);
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const raw = encodeMimeMessage(input);

    try {
      const response = await this.messagesClient.send({
        userId: "me",
        requestBody: {
          raw
        }
      });

      return {
        provider: EMAIL_PROVIDER.gmail,
        providerMessageId: response.data.id ?? undefined,
        accepted: true,
        raw: {
          id: response.data.id,
          threadId: response.data.threadId,
          labelIds: response.data.labelIds
        }
      };
    } catch (error) {
      throw normalizeGmailError(error);
    }
  }
}

function createGmailMessagesClient(config: GmailEmailProviderConfig): GmailMessagesClient {
  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key: config.privateKey,
    subject: config.impersonatedEmail,
    scopes: [GMAIL_SEND_SCOPE]
  });
  const gmail = google.gmail({
    version: "v1",
    auth
  });

  return gmail.users.messages;
}

function encodeMimeMessage(input: SendEmailInput): string {
  const mimeMessage = input.html ? encodeMultipartMimeMessage(input) : encodeTextMimeMessage(input);

  return Buffer.from(mimeMessage, "utf8")
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function encodeTextMimeMessage(input: SendEmailInput): string {
  return [
    `From: ${formatAddress(input.fromEmail)}`,
    `To: ${formatAddress(input.toEmail)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text
  ].join("\r\n");
}

function encodeMultipartMimeMessage(input: SendEmailInput): string {
  const boundary = `caw-itops-${Date.now().toString(36)}`;

  return [
    `From: ${formatAddress(input.fromEmail)}`,
    `To: ${formatAddress(input.toEmail)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.html ?? "",
    `--${boundary}--`,
    ""
  ].join("\r\n");
}

function formatAddress(email: string): string {
  return email.trim();
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/u.test(value)) {
    return value.replace(/\r|\n/gu, " ");
  }

  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

type GmailApiErrorLike = {
  code?: number;
  message?: string;
  response?: {
    status?: number;
    data?: {
      error?: {
        code?: number;
        message?: string;
        status?: string;
      } | string;
      error_description?: string;
    };
  };
};

function normalizeGmailError(error: unknown): GmailEmailProviderError {
  if (error instanceof GmailEmailProviderError) {
    return error;
  }

  const statusCode = getStatusCode(error);
  const message = getErrorMessage(error) ?? defaultMessageForStatus(statusCode);

  return new GmailEmailProviderError({
    code: codeForStatus(statusCode),
    message,
    statusCode,
    details: getSafeDetails(error),
    cause: error
  });
}

function getStatusCode(error: unknown): number | undefined {
  const gmailError = error as GmailApiErrorLike;
  return gmailError.response?.status ?? gmailError.code;
}

function getErrorMessage(error: unknown): string | undefined {
  const gmailError = error as GmailApiErrorLike;
  const bodyError = gmailError.response?.data?.error;

  if (typeof bodyError === "object" && typeof bodyError.message === "string" && bodyError.message.trim()) {
    return bodyError.message;
  }

  if (typeof gmailError.response?.data?.error_description === "string") {
    return gmailError.response.data.error_description;
  }

  if (typeof gmailError.message === "string" && gmailError.message.trim()) {
    return gmailError.message;
  }

  return undefined;
}

function codeForStatus(statusCode: number | undefined): GmailEmailErrorCode {
  if (statusCode === 401) {
    return GMAIL_EMAIL_ERROR_CODE.authFailed;
  }

  if (statusCode === 403) {
    return GMAIL_EMAIL_ERROR_CODE.permissionDenied;
  }

  if (statusCode === 429) {
    return GMAIL_EMAIL_ERROR_CODE.rateLimited;
  }

  if (statusCode && statusCode >= 400) {
    return GMAIL_EMAIL_ERROR_CODE.sendFailed;
  }

  return GMAIL_EMAIL_ERROR_CODE.unknown;
}

function defaultMessageForStatus(statusCode: number | undefined): string {
  if (statusCode === 401) {
    return "Gmail authentication failed.";
  }

  if (statusCode === 403) {
    return "Gmail send permission was denied.";
  }

  if (statusCode === 429) {
    return "Gmail rate limit exceeded.";
  }

  return "Gmail send failed.";
}

function getSafeDetails(error: unknown): Record<string, unknown> | undefined {
  const gmailError = error as GmailApiErrorLike;
  const bodyError = gmailError.response?.data?.error;

  if (typeof bodyError === "object" && bodyError.status) {
    return {
      status: bodyError.status
    };
  }

  return undefined;
}

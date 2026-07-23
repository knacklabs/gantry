import { EMAIL_MESSAGE_STATUS } from "@itops/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailRepository, type EmailMessage } from "./email.repository.js";
import { EmailService } from "./email.service.js";
import { EMAIL_PROVIDER, EMAIL_TEMPLATE_KEY, type EmailConfig, type EmailProvider } from "./email.types.js";
import { GmailEmailProviderError, GMAIL_EMAIL_ERROR_CODE } from "./providers/gmail-email.provider.js";
import { EmailTemplateRegistry } from "./templates/email-template.registry.js";

type EmailRepositoryMock = {
  findByIdempotencyKey: ReturnType<typeof vi.fn>;
  createEmailMessage: ReturnType<typeof vi.fn>;
  markSending: ReturnType<typeof vi.fn>;
  markSent: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  markSkipped: ReturnType<typeof vi.fn>;
};

describe("EmailService", () => {
  let repository: EmailRepositoryMock;
  let provider: EmailProvider;
  let config: EmailConfig;
  let service: EmailService;

  beforeEach(() => {
    repository = {
      findByIdempotencyKey: vi.fn(),
      createEmailMessage: vi.fn(async (input) => makeEmailMessage(input)),
      markSending: vi.fn(async (id) => makeEmailMessage({ id, status: EMAIL_MESSAGE_STATUS.sending })),
      markSent: vi.fn(async (input) =>
        makeEmailMessage({
          id: input.id,
          status: EMAIL_MESSAGE_STATUS.sent,
          providerMessageId: input.providerMessageId,
          metadataJson: input.safeMetadata
        })
      ),
      markFailed: vi.fn(async (input) =>
        makeEmailMessage({
          id: input.id,
          status: EMAIL_MESSAGE_STATUS.failed,
          errorMessage: input.errorMessage,
          metadataJson: input.safeMetadata
        })
      ),
      markSkipped: vi.fn(async (input) =>
        makeEmailMessage({
          id: input.id,
          status: EMAIL_MESSAGE_STATUS.skipped,
          errorMessage: input.reason,
          metadataJson: input.safeMetadata
        })
      )
    };
    provider = {
      send: vi.fn(async () => ({
        provider: EMAIL_PROVIDER.gmail,
        providerMessageId: "gmail-message-1",
        accepted: true,
        raw: {
          id: "gmail-message-1"
        }
      }))
    };
    config = {
      itopsFrom: "itops@caw.tech",
      gmailClientEmail: "service-account@example.iam.gserviceaccount.com",
      gmailPrivateKey: "private-key",
      gmailImpersonatedItopsEmail: "itops@caw.tech"
    };
    service = makeService();
  });

  it("skips when Gmail is not configured", async () => {
    config = {};
    service = makeService(null);

    await expect(service.sendGoogleWorkspaceWelcomeEmail(makeInput())).resolves.toEqual({
      status: "skipped",
      emailMessageId: "email-message-1",
      reason: "gmail_not_configured"
    });

    expect(provider.send).not.toHaveBeenCalled();
    expect(repository.markSkipped).toHaveBeenCalledWith({
      id: "email-message-1",
      reason: "gmail_not_configured",
      safeMetadata: {
        employeeId: "employee-1",
        accessTaskId: "access-task-1",
        workEmail: "riya.sharma@company.com",
        reason: "gmail_not_configured"
      }
    });
  });

  it("skips when personal email is missing", async () => {
    await expect(service.sendGoogleWorkspaceWelcomeEmail({
      ...makeInput(),
      personalEmail: null
    })).resolves.toEqual({
      status: "skipped",
      emailMessageId: "email-message-1",
      reason: "missing_personal_email"
    });

    expect(provider.send).not.toHaveBeenCalled();
    expect(repository.markSkipped).toHaveBeenCalledWith({
      id: "email-message-1",
      reason: "missing_personal_email",
      safeMetadata: {
        employeeId: "employee-1",
        accessTaskId: "access-task-1",
        workEmail: "riya.sharma@company.com",
        reason: "missing_personal_email"
      }
    });
  });

  it("does not resend a duplicate sent email", async () => {
    repository.findByIdempotencyKey.mockResolvedValue(makeEmailMessage({
      status: EMAIL_MESSAGE_STATUS.sent
    }));

    await expect(service.sendGoogleWorkspaceWelcomeEmail(makeInput())).resolves.toEqual({
      status: "sent",
      emailMessageId: "email-message-1"
    });

    expect(provider.send).not.toHaveBeenCalled();
    expect(repository.createEmailMessage).not.toHaveBeenCalled();
  });

  it("marks a provider success as sent", async () => {
    await expect(service.sendGoogleWorkspaceWelcomeEmail(makeInput())).resolves.toEqual({
      status: "sent",
      emailMessageId: "email-message-1"
    });

    expect(provider.send).toHaveBeenCalledWith({
      fromEmail: "itops@caw.tech",
      toEmail: "riya.personal@example.com",
      subject: "Welcome to CAW - your email account is ready",
      text: expect.stringContaining("temp-password-123"),
      html: expect.stringContaining("temp-password-123")
    });
    expect(repository.markSent).toHaveBeenCalledWith({
      id: "email-message-1",
      providerMessageId: "gmail-message-1",
      safeMetadata: {
        employeeId: "employee-1",
        accessTaskId: "access-task-1",
        workEmail: "riya.sharma@company.com",
        provider: {
          provider: EMAIL_PROVIDER.gmail,
          providerMessageId: "gmail-message-1",
          accepted: true,
          raw: {
            id: "gmail-message-1"
          }
        }
      }
    });
    expect(JSON.stringify(repository.markSent.mock.calls)).not.toContain("temp-password-123");
  });

  it("marks provider failure as failed without throwing", async () => {
    vi.mocked(provider.send).mockRejectedValue(new GmailEmailProviderError({
      code: GMAIL_EMAIL_ERROR_CODE.permissionDenied,
      message: "Gmail send permission was denied.",
      statusCode: 403
    }));

    await expect(service.sendGoogleWorkspaceWelcomeEmail(makeInput())).resolves.toEqual({
      status: "failed",
      emailMessageId: "email-message-1",
      reason: GMAIL_EMAIL_ERROR_CODE.permissionDenied
    });

    expect(repository.markFailed).toHaveBeenCalledWith({
      id: "email-message-1",
      errorMessage: "Gmail send permission was denied.",
      safeMetadata: {
        employeeId: "employee-1",
        accessTaskId: "access-task-1",
        workEmail: "riya.sharma@company.com",
        provider: {
          code: GMAIL_EMAIL_ERROR_CODE.permissionDenied,
          message: "Gmail send permission was denied.",
          statusCode: 403,
          details: undefined
        }
      }
    });
    expect(JSON.stringify(repository.markFailed.mock.calls)).not.toContain("temp-password-123");
  });

  function makeService(emailProvider: EmailProvider | null = provider): EmailService {
    return new EmailService(
      repository as unknown as EmailRepository,
      new EmailTemplateRegistry(),
      config,
      emailProvider
    );
  }
});

function makeInput() {
  return {
    employeeId: "employee-1",
    accessTaskId: "access-task-1",
    employeeFullName: "Riya Sharma",
    personalEmail: "riya.personal@example.com",
    workEmail: "riya.sharma@company.com",
    temporaryPassword: "temp-password-123"
  };
}

function makeEmailMessage(overrides: Partial<EmailMessage> & Record<string, unknown> = {}): EmailMessage {
  return {
    id: "email-message-1",
    idempotencyKey: `${EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome}:access-task-1`,
    templateKey: EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome,
    senderType: "itops",
    fromEmail: "itops@caw.tech",
    toEmail: "riya.personal@example.com",
    subject: "Your company email account is ready",
    status: EMAIL_MESSAGE_STATUS.pending,
    provider: EMAIL_PROVIDER.gmail,
    providerMessageId: null,
    relatedEntityType: "access_task",
    relatedEntityId: "access-task-1",
    errorMessage: null,
    metadataJson: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    sentAt: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

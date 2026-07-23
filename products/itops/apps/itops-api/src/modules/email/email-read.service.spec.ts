import { NotFoundException } from "@nestjs/common";
import { EMAIL_MESSAGE_STATUS } from "@itops/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailReadService, sanitizeEmailMetadata } from "./email-read.service.js";
import { EmailRepository, type EmailMessage } from "./email.repository.js";

type EmailRepositoryMock = {
  findById: ReturnType<typeof vi.fn>;
  listForEmployee: ReturnType<typeof vi.fn>;
};

describe("EmailReadService", () => {
  let repository: EmailRepositoryMock;
  let service: EmailReadService;

  beforeEach(() => {
    repository = {
      findById: vi.fn(),
      listForEmployee: vi.fn()
    };
    service = new EmailReadService(repository as unknown as EmailRepository);
  });

  it("returns employee email messages as safe DTOs", async () => {
    const newer = makeEmailMessage({
      id: "6918c459-68a4-4604-9135-624f4f858ecb",
      createdAt: new Date("2026-06-02T00:00:00.000Z")
    });
    const older = makeEmailMessage({
      id: "a12a5bfa-4324-42e8-9164-0471101d069a",
      createdAt: new Date("2026-06-01T00:00:00.000Z")
    });
    repository.listForEmployee.mockResolvedValue([newer, older]);

    await expect(service.listEmployeeEmails("8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe")).resolves.toEqual([
      expect.objectContaining({
        id: newer.id,
        metadataJson: {
          employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
          accessTaskId: "5be86c97-ed19-4eb6-b114-fc4305aab8d7",
          workEmail: "riya.sharma@company.com",
          provider: {
            provider: "gmail",
            providerMessageId: "gmail-message-1",
            accepted: true
          }
        }
      }),
      expect.objectContaining({
        id: older.id
      })
    ]);
    expect(repository.listForEmployee).toHaveBeenCalledWith("8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe");
  });

  it("returns one email message by id without idempotency key or secrets", async () => {
    const emailMessage = makeEmailMessage();
    repository.findById.mockResolvedValue(emailMessage);

    const result = await service.findEmailMessageById(emailMessage.id);

    expect(result).toEqual(expect.objectContaining({
      id: emailMessage.id,
      templateKey: "google_workspace_welcome",
      status: EMAIL_MESSAGE_STATUS.sent
    }));
    expect("idempotencyKey" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("temp-password-123");
    expect(JSON.stringify(result)).not.toContain("private-key");
    expect(JSON.stringify(result)).not.toContain("access-token");
    expect(JSON.stringify(result)).not.toContain("rendered body");
  });

  it("returns not found for malformed and missing email message ids", async () => {
    await expect(service.findEmailMessageById("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findById).not.toHaveBeenCalled();

    repository.findById.mockResolvedValue(undefined);

    await expect(service.findEmailMessageById("6918c459-68a4-4604-9135-624f4f858ecb")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("sanitizes metadata to the safe allowlist", () => {
    expect(sanitizeEmailMetadata({
      employeeId: "employee-1",
      accessTaskId: "task-1",
      workEmail: "riya.sharma@company.com",
      temporaryPassword: "temp-password-123",
      renderedBody: "rendered body",
      provider: {
        provider: "gmail",
        providerMessageId: "gmail-message-1",
        accepted: true,
        raw: {
          headers: {
            authorization: "Bearer access-token"
          }
        },
        details: {
          status: "safe",
          accessToken: "access-token"
        }
      },
      gmailPrivateKey: "private-key"
    })).toEqual({
      employeeId: "employee-1",
      accessTaskId: "task-1",
      workEmail: "riya.sharma@company.com",
      provider: {
        provider: "gmail",
        providerMessageId: "gmail-message-1",
        accepted: true,
        details: {
          status: "safe"
        }
      }
    });
  });
});

function makeEmailMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "6918c459-68a4-4604-9135-624f4f858ecb",
    idempotencyKey: "google_workspace_welcome:5be86c97-ed19-4eb6-b114-fc4305aab8d7",
    templateKey: "google_workspace_welcome",
    senderType: "itops",
    fromEmail: "itops@caw.tech",
    toEmail: "riya.personal@example.com",
    subject: "Your CAW email account is ready",
    status: EMAIL_MESSAGE_STATUS.sent,
    provider: "gmail",
    providerMessageId: "gmail-message-1",
    relatedEntityType: "access_task",
    relatedEntityId: "5be86c97-ed19-4eb6-b114-fc4305aab8d7",
    errorMessage: null,
    metadataJson: {
      employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
      accessTaskId: "5be86c97-ed19-4eb6-b114-fc4305aab8d7",
      workEmail: "riya.sharma@company.com",
      temporaryPassword: "temp-password-123",
      renderedText: "rendered body",
      gmailPrivateKey: "private-key",
      provider: {
        provider: "gmail",
        providerMessageId: "gmail-message-1",
        accepted: true,
        raw: {
          id: "gmail-message-1",
          headers: {
            authorization: "Bearer access-token"
          }
        }
      }
    },
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    sentAt: new Date("2026-06-01T00:01:00.000Z"),
    updatedAt: new Date("2026-06-01T00:01:00.000Z"),
    ...overrides
  };
}

import { Inject, Injectable } from "@nestjs/common";
import { EMAIL_MESSAGE_STATUS } from "@itops/db";

import {
  EMAIL_PROVIDER,
  EMAIL_TEMPLATE_KEY,
  type EmailConfig,
  type EmailProvider,
  type EmailSendOutcome,
  type SendEmailResult
} from "./email.types.js";
import { EmailRepository, type EmailMessage } from "./email.repository.js";
import { EMAIL_CONFIG, EMAIL_PROVIDER_INSTANCE } from "./email.tokens.js";
import { GmailEmailProviderError } from "./providers/gmail-email.provider.js";
import { EmailTemplateRegistry } from "./templates/email-template.registry.js";

export type SendGoogleWorkspaceWelcomeEmailInput = {
  employeeId: string;
  accessTaskId: string;
  employeeFullName: string;
  personalEmail: string | null;
  workEmail: string;
  temporaryPassword?: string;
};

@Injectable()
export class EmailService {
  constructor(
    private readonly emailRepository: EmailRepository,
    private readonly templateRegistry: EmailTemplateRegistry,
    @Inject(EMAIL_CONFIG) private readonly emailConfig: EmailConfig,
    @Inject(EMAIL_PROVIDER_INSTANCE) private readonly emailProvider: EmailProvider | null
  ) {}

  async sendGoogleWorkspaceWelcomeEmail(
    input: SendGoogleWorkspaceWelcomeEmailInput
  ): Promise<EmailSendOutcome> {
    const idempotencyKey = `${EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome}:${input.accessTaskId}`;
    const existingEmailMessage = await this.emailRepository.findByIdempotencyKey(idempotencyKey);

    if (existingEmailMessage) {
      const existingOutcome = toTerminalOutcome(existingEmailMessage);

      if (existingOutcome) {
        return existingOutcome;
      }
    }

    const rendered = this.templateRegistry.render(EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome, {
      employeeFullName: input.employeeFullName,
      workEmail: input.workEmail,
      temporaryPassword: input.temporaryPassword
    });

    const emailMessage =
      existingEmailMessage ??
      (await this.emailRepository.createEmailMessage({
        idempotencyKey,
        templateKey: EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome,
        senderType: "itops",
        fromEmail: this.emailConfig.itopsFrom ?? "",
        toEmail: input.personalEmail ?? "",
        subject: rendered.subject,
        provider: EMAIL_PROVIDER.gmail,
        relatedEntityType: "access_task",
        relatedEntityId: input.accessTaskId,
        metadataJson: safeBaseMetadata(input)
      }));

    if (!input.personalEmail) {
      const skipped = await this.emailRepository.markSkipped({
        id: emailMessage.id,
        reason: "missing_personal_email",
        safeMetadata: {
          ...safeBaseMetadata(input),
          reason: "missing_personal_email"
        }
      });

      return {
        status: "skipped",
        emailMessageId: skipped.id,
        reason: "missing_personal_email"
      };
    }

    if (!isGmailConfigured(this.emailConfig) || !this.emailProvider) {
      const skipped = await this.emailRepository.markSkipped({
        id: emailMessage.id,
        reason: "gmail_not_configured",
        safeMetadata: {
          ...safeBaseMetadata(input),
          reason: "gmail_not_configured"
        }
      });

      return {
        status: "skipped",
        emailMessageId: skipped.id,
        reason: "gmail_not_configured"
      };
    }

    await this.emailRepository.markSending(emailMessage.id);

    try {
      const providerResult = await this.emailProvider.send({
        fromEmail: this.emailConfig.itopsFrom!,
        toEmail: input.personalEmail,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html
      });

      const sent = await this.emailRepository.markSent({
        id: emailMessage.id,
        providerMessageId: providerResult.providerMessageId,
        safeMetadata: {
          ...safeBaseMetadata(input),
          provider: toSafeProviderResult(providerResult)
        }
      });

      return {
        status: "sent",
        emailMessageId: sent.id
      };
    } catch (error) {
      const safeError = toSafeEmailError(error);
      const failed = await this.emailRepository.markFailed({
        id: emailMessage.id,
        errorMessage: safeError.message,
        safeMetadata: {
          ...safeBaseMetadata(input),
          provider: safeError
        }
      });

      return {
        status: "failed",
        emailMessageId: failed.id,
        reason: safeError.code
      };
    }
  }
}

function isGmailConfigured(config: EmailConfig): boolean {
  return Boolean(
    config.itopsFrom &&
      config.gmailClientEmail &&
      config.gmailPrivateKey &&
      config.gmailImpersonatedItopsEmail
  );
}

function toTerminalOutcome(emailMessage: EmailMessage): EmailSendOutcome | null {
  if (emailMessage.status === EMAIL_MESSAGE_STATUS.sent) {
    return {
      status: "sent",
      emailMessageId: emailMessage.id
    };
  }

  if (emailMessage.status === EMAIL_MESSAGE_STATUS.failed) {
    return {
      status: "failed",
      emailMessageId: emailMessage.id,
      reason: emailMessage.errorMessage ?? undefined
    };
  }

  if (emailMessage.status === EMAIL_MESSAGE_STATUS.skipped) {
    return {
      status: "skipped",
      emailMessageId: emailMessage.id,
      reason: emailMessage.errorMessage ?? undefined
    };
  }

  return null;
}

function safeBaseMetadata(input: SendGoogleWorkspaceWelcomeEmailInput): Record<string, unknown> {
  return {
    employeeId: input.employeeId,
    accessTaskId: input.accessTaskId,
    workEmail: input.workEmail
  };
}

function toSafeProviderResult(result: SendEmailResult): Record<string, unknown> {
  return {
    provider: result.provider,
    providerMessageId: result.providerMessageId,
    accepted: result.accepted,
    raw: result.raw
  };
}

function toSafeEmailError(error: unknown): {
  code: string;
  message: string;
  statusCode?: number;
  details?: Record<string, unknown>;
} {
  if (error instanceof GmailEmailProviderError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      details: error.details
    };
  }

  return {
    code: "email_send_failed",
    message: "Email send failed."
  };
}

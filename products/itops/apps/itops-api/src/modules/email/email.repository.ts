import { Injectable } from "@nestjs/common";
import { auditEvents, EMAIL_MESSAGE_STATUS, emailMessages } from "@itops/db";
import { desc, eq, or, sql } from "drizzle-orm";

import { DatabaseProvider } from "../../database/database.provider.js";

export type EmailMessage = typeof emailMessages.$inferSelect;

export type CreateEmailMessageInput = {
  idempotencyKey: string;
  templateKey: string;
  senderType: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  provider: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  metadataJson?: Record<string, unknown> | null;
};

export type MarkEmailSentInput = {
  id: string;
  providerMessageId?: string;
  safeMetadata?: Record<string, unknown>;
};

export type MarkEmailFailedInput = {
  id: string;
  errorMessage: string;
  safeMetadata?: Record<string, unknown>;
};

export type MarkEmailSkippedInput = {
  id: string;
  reason: string;
  safeMetadata?: Record<string, unknown>;
};

const EMAIL_AUDIT_ACTOR = "system:email-service";

@Injectable()
export class EmailRepository {
  constructor(private readonly databaseProvider: DatabaseProvider) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<EmailMessage | undefined> {
    const [emailMessage] = await this.databaseProvider.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.idempotencyKey, idempotencyKey))
      .limit(1);

    return emailMessage;
  }

  async findById(id: string): Promise<EmailMessage | undefined> {
    const [emailMessage] = await this.databaseProvider.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, id))
      .limit(1);

    return emailMessage;
  }

  async listForEmployee(employeeId: string): Promise<EmailMessage[]> {
    return this.databaseProvider.db
      .select()
      .from(emailMessages)
      .where(
        or(
          sql`${emailMessages.metadataJson}->>'employeeId' = ${employeeId}`,
          sql`${emailMessages.relatedEntityType} = 'employee' and ${emailMessages.relatedEntityId} = ${employeeId}::uuid`
        )
      )
      .orderBy(desc(emailMessages.createdAt));
  }

  async createEmailMessage(input: CreateEmailMessageInput): Promise<EmailMessage> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(emailMessages)
        .values({
          idempotencyKey: input.idempotencyKey,
          templateKey: input.templateKey,
          senderType: input.senderType,
          fromEmail: input.fromEmail,
          toEmail: input.toEmail,
          subject: input.subject,
          status: EMAIL_MESSAGE_STATUS.pending,
          provider: input.provider,
          relatedEntityType: input.relatedEntityType ?? null,
          relatedEntityId: input.relatedEntityId ?? null,
          metadataJson: input.metadataJson ?? null
        })
        .onConflictDoNothing({ target: emailMessages.idempotencyKey })
        .returning();

      if (created) {
        return created;
      }

      const [existing] = await tx
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.idempotencyKey, input.idempotencyKey))
        .limit(1);

      if (!existing) {
        throw new Error("Email message idempotency lookup failed.");
      }

      return existing;
    });
  }

  async markSending(id: string): Promise<EmailMessage> {
    const [emailMessage] = await this.databaseProvider.db
      .update(emailMessages)
      .set({
        status: EMAIL_MESSAGE_STATUS.sending,
        updatedAt: new Date()
      })
      .where(eq(emailMessages.id, id))
      .returning();

    return emailMessage;
  }

  async markSent(input: MarkEmailSentInput): Promise<EmailMessage> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [emailMessage] = await tx
        .update(emailMessages)
        .set({
          status: EMAIL_MESSAGE_STATUS.sent,
          providerMessageId: input.providerMessageId ?? null,
          metadataJson: input.safeMetadata ?? null,
          errorMessage: null,
          sentAt: now,
          updatedAt: now
        })
        .where(eq(emailMessages.id, input.id))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: EMAIL_AUDIT_ACTOR,
        eventType: "email.sent",
        entityType: "email_message",
        entityId: emailMessage.id,
        afterJson: toAuditAfterJson(emailMessage),
        metadataJson: toAuditMetadata(emailMessage, {
          provider_message_id: input.providerMessageId ?? null
        })
      });

      return emailMessage;
    });
  }

  async markFailed(input: MarkEmailFailedInput): Promise<EmailMessage> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [emailMessage] = await tx
        .update(emailMessages)
        .set({
          status: EMAIL_MESSAGE_STATUS.failed,
          errorMessage: input.errorMessage,
          metadataJson: input.safeMetadata ?? null,
          updatedAt: now
        })
        .where(eq(emailMessages.id, input.id))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: EMAIL_AUDIT_ACTOR,
        eventType: "email.failed",
        entityType: "email_message",
        entityId: emailMessage.id,
        afterJson: toAuditAfterJson(emailMessage),
        metadataJson: toAuditMetadata(emailMessage, {
          reason: input.errorMessage
        })
      });

      return emailMessage;
    });
  }

  async markSkipped(input: MarkEmailSkippedInput): Promise<EmailMessage> {
    return this.databaseProvider.db.transaction(async (tx) => {
      const now = new Date();
      const [emailMessage] = await tx
        .update(emailMessages)
        .set({
          status: EMAIL_MESSAGE_STATUS.skipped,
          errorMessage: input.reason,
          metadataJson: input.safeMetadata ?? null,
          updatedAt: now
        })
        .where(eq(emailMessages.id, input.id))
        .returning();

      await tx.insert(auditEvents).values({
        actorExternalUserId: EMAIL_AUDIT_ACTOR,
        eventType: "email.skipped",
        entityType: "email_message",
        entityId: emailMessage.id,
        afterJson: toAuditAfterJson(emailMessage),
        metadataJson: toAuditMetadata(emailMessage, {
          reason: input.reason
        })
      });

      return emailMessage;
    });
  }
}

function toAuditAfterJson(emailMessage: EmailMessage): Record<string, unknown> {
  return {
    id: emailMessage.id,
    idempotencyKey: emailMessage.idempotencyKey,
    templateKey: emailMessage.templateKey,
    senderType: emailMessage.senderType,
    status: emailMessage.status,
    provider: emailMessage.provider,
    providerMessageId: emailMessage.providerMessageId,
    relatedEntityType: emailMessage.relatedEntityType,
    relatedEntityId: emailMessage.relatedEntityId,
    errorMessage: emailMessage.errorMessage,
    sentAt: emailMessage.sentAt
  };
}

function toAuditMetadata(emailMessage: EmailMessage, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    template_key: emailMessage.templateKey,
    related_entity_type: emailMessage.relatedEntityType,
    related_entity_id: emailMessage.relatedEntityId,
    provider: emailMessage.provider,
    ...extra
  };
}

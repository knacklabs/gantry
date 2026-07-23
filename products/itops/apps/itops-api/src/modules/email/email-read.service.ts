import { Injectable, NotFoundException } from "@nestjs/common";

import { isUuid } from "../../common/validation.js";
import { EmailRepository, type EmailMessage } from "./email.repository.js";

export type SafeEmailMessage = Omit<EmailMessage, "idempotencyKey" | "metadataJson"> & {
  metadataJson: Record<string, unknown> | null;
};

const TOP_LEVEL_METADATA_KEYS = new Set([
  "employeeId",
  "accessTaskId",
  "workEmail",
  "reason",
  "provider"
]);

const PROVIDER_METADATA_KEYS = new Set([
  "provider",
  "providerMessageId",
  "accepted",
  "code",
  "message",
  "statusCode",
  "details"
]);

const SENSITIVE_KEY_PATTERN =
  /(password|temporary|private.?key|token|secret|credential|authorization|cookie|localstorage|session|body|html|text|raw|headers)/iu;

@Injectable()
export class EmailReadService {
  constructor(private readonly emailRepository: EmailRepository) {}

  async listEmployeeEmails(employeeId: string): Promise<SafeEmailMessage[]> {
    return (await this.emailRepository.listForEmployee(employeeId)).map(toSafeEmailMessage);
  }

  async findEmailMessageById(id: string): Promise<SafeEmailMessage> {
    if (!isUuid(id)) {
      throw new NotFoundException("Email message not found.");
    }

    const emailMessage = await this.emailRepository.findById(id);

    if (!emailMessage) {
      throw new NotFoundException("Email message not found.");
    }

    return toSafeEmailMessage(emailMessage);
  }
}

export function toSafeEmailMessage(emailMessage: EmailMessage): SafeEmailMessage {
  const { idempotencyKey: _idempotencyKey, metadataJson, ...safeEmailMessage } = emailMessage;

  return {
    ...safeEmailMessage,
    metadataJson: sanitizeEmailMetadata(metadataJson)
  };
}

export function sanitizeEmailMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  const sanitized: Record<string, unknown> = {};

  for (const key of TOP_LEVEL_METADATA_KEYS) {
    if (!(key in metadata) || SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }

    const value = metadata[key];

    if (key === "provider") {
      const provider = sanitizeProviderMetadata(value);

      if (provider) {
        sanitized[key] = provider;
      }

      continue;
    }

    const safeValue = sanitizeJsonValue(value);

    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizeProviderMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};

  for (const key of PROVIDER_METADATA_KEYS) {
    if (!(key in value) || SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }

    const safeValue = sanitizeJsonValue(value[key]);

    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const sanitized = value
      .map((item) => sanitizeJsonValue(item))
      .filter((item) => item !== undefined);

    return sanitized;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, childValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }

    const safeChildValue = sanitizeJsonValue(childValue);

    if (safeChildValue !== undefined) {
      sanitized[key] = safeChildValue;
    }
  }

  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

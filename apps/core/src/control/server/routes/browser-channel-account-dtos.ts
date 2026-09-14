import type { IncomingMessage, ServerResponse } from 'node:http';

import { readJson, sendError } from '../http.js';

export type AccountCreationBody = {
  agentId: string;
  providerId: string;
  label: string;
  credentials: Record<string, string>;
};

export type ConversationInstallBody = {
  providerAccountId: string;
  memoryScope: 'conversation' | 'agent' | 'app';
};

export async function readConversationInstallBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ConversationInstallBody | null> {
  const value = await readBody(req, res);
  if (!value) return null;
  if (
    Object.keys(value).some(
      (key) => !['providerAccountId', 'memoryScope'].includes(key),
    ) ||
    typeof value.providerAccountId !== 'string' ||
    !value.providerAccountId.trim() ||
    !['conversation', 'agent', 'app'].includes(String(value.memoryScope))
  ) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Conversation installation details are incomplete.',
    );
    return null;
  }
  return {
    providerAccountId: value.providerAccountId.trim(),
    memoryScope: value.memoryScope as ConversationInstallBody['memoryScope'],
  };
}

export async function readApproverIds(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string[] | null> {
  const value = await readBody(req, res);
  if (!value) return null;
  if (
    Object.keys(value).some((key) => key !== 'userIds') ||
    !Array.isArray(value.userIds) ||
    value.userIds.length === 0 ||
    value.userIds.some((userId) => typeof userId !== 'string' || !userId.trim())
  ) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Enter at least one provider member ID.',
    );
    return null;
  }
  return [...new Set(value.userIds.map((userId) => userId.trim()))];
}

export async function readAccountCreationBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AccountCreationBody | null> {
  const value = await readBody(req, res);
  if (!value) return null;
  if (
    Object.keys(value).some(
      (key) => !['agentId', 'providerId', 'label', 'credentials'].includes(key),
    ) ||
    typeof value.agentId !== 'string' ||
    !value.agentId.trim() ||
    typeof value.providerId !== 'string' ||
    !value.providerId.trim() ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    !isRecord(value.credentials) ||
    Object.values(value.credentials).some(
      (credential) => typeof credential !== 'string' || !credential.trim(),
    )
  ) {
    sendError(res, 400, 'INVALID_REQUEST', 'Account details are incomplete.');
    return null;
  }
  return {
    agentId: value.agentId.trim(),
    providerId: value.providerId.trim(),
    label: value.label.trim(),
    credentials: value.credentials as Record<string, string>,
  };
}

async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  try {
    const value = await readJson(req);
    if (isRecord(value)) return value;
  } catch {
    // The common safe envelope is returned below.
  }
  sendError(res, 400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

import fs from 'fs';
import path from 'path';

import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { ParsedConversationHistoryIpcRequest } from './ipc-parsing.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 1_000;
const MESSAGE_TEXT_MAX_CHARS = 4_000;

type ConversationHistoryResponse = {
  ok: boolean;
  requestId: string;
  data?: unknown;
  error?: string;
};

export async function processConversationHistoryRequest(input: {
  request: ParsedConversationHistoryIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<ConversationHistoryResponse> {
  const { request, sourceAgentFolder, deps } = input;
  try {
    if (!deps.getConversationThreadHistory) {
      throw new Error('Conversation history service is unavailable');
    }
    const limit = clampInteger(request.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const maxChars = clampInteger(
      request.maxChars,
      DEFAULT_MAX_CHARS,
      MIN_MAX_CHARS,
      MAX_MAX_CHARS,
    );
    const result = await deps.getConversationThreadHistory({
      sourceAgentFolder,
      chatJid: request.chatJid,
      threadId: request.threadId,
      limit,
    });
    const shaped = shapeTranscript(result.messages, maxChars);
    return {
      ok: true,
      requestId: request.requestId,
      data: {
        schema: 'gantry.conversation_thread_history.v1',
        trust: 'untrusted_user_generated_conversation_data',
        scope: {
          chatJid: request.chatJid,
          threadId: request.threadId,
        },
        limit,
        maxChars,
        messages: shaped.messages,
        truncated:
          shaped.truncated || result.messages.length > shaped.messages.length,
      },
    };
  } catch (err) {
    return {
      ok: false,
      requestId: request.requestId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function writeConversationHistoryResponse(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  requestId: string;
  response: ConversationHistoryResponse;
  privateKeyPem?: string;
}): void {
  assertValidConversationHistoryRequestId(input.requestId);
  const responsesDir = path.join(
    input.ipcBaseDir,
    input.sourceAgentFolder,
    'conversation-history-responses',
  );
  ensurePrivateDirSync(responsesDir);
  const responsePath = path.join(responsesDir, `${input.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  const payload: Record<string, unknown> = {
    ok: input.response.ok,
    requestId: input.response.requestId,
    ...(Object.prototype.hasOwnProperty.call(input.response, 'data')
      ? { data: input.response.data }
      : {}),
    ...(input.response.error ? { error: input.response.error } : {}),
  };
  const signature = signIpcResponsePayload(input.privateKeyPem, payload);
  if (!signature) return;
  payload.signature = signature;
  writePrivateFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, responsePath);
}

function shapeTranscript(
  messages: Array<{
    id: string;
    createdAt: string;
    direction: string;
    senderDisplayName?: string;
    text: string;
  }>,
  maxChars: number,
): {
  messages: Array<{
    id: string;
    createdAt: string;
    direction: string;
    senderDisplayName?: string;
    text: string;
  }>;
  truncated: boolean;
} {
  const shaped: Array<{
    id: string;
    createdAt: string;
    direction: string;
    senderDisplayName?: string;
    text: string;
  }> = [];
  let remaining = maxChars;
  let truncated = false;
  for (const message of messages) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const normalizedText = normalizeTranscriptText(message.text);
    if (!normalizedText) continue;
    const text =
      normalizedText.length > Math.min(remaining, MESSAGE_TEXT_MAX_CHARS)
        ? `${normalizedText.slice(0, Math.max(0, Math.min(remaining, MESSAGE_TEXT_MAX_CHARS) - 22)).trimEnd()} [message truncated]`
        : normalizedText;
    if (text !== normalizedText) truncated = true;
    remaining -= text.length;
    shaped.push({
      id: message.id,
      createdAt: message.createdAt,
      direction: message.direction,
      ...(message.senderDisplayName
        ? { senderDisplayName: message.senderDisplayName }
        : {}),
      text,
    });
  }
  return { messages: shaped, truncated };
}

function normalizeTranscriptText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function assertValidConversationHistoryRequestId(requestId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(requestId)) {
    throw new Error('Invalid conversation history IPC requestId');
  }
}

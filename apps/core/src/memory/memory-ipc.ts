import fs from 'fs';
import path from 'path';
import {
  MemoryIpcAction,
  MEMORY_IPC_ACTIONS,
  MemoryIpcRequest,
  MemoryIpcResponse,
} from '@myclaw/contracts';

import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isPlainObject } from '../shared/object.js';
import { resolveGroupIpcPath } from '../platform/group-folder.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from './app-memory-boundaries.js';
import {
  resolveScopedMemorySubject,
  canonicalConversationIdForMemory,
  searchInputForResolvedMemorySubject,
} from './app-memory-subject-resolver.js';
import { AppMemoryService } from './app-memory-service.js';
import {
  isDirectSaveMemoryKind,
  PatchMemoryInput,
  PatchProcedureInput,
  SaveMemoryInput,
  SaveProcedureInput,
} from './memory-types.js';

const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

interface TrustedMemoryContext {
  threadId?: string;
  chatJid?: string;
  userId?: string;
  defaultScope?: 'user' | 'group';
}

type TrustedMemoryRequest = Omit<MemoryIpcRequest, 'context'> & {
  context?: TrustedMemoryContext;
  allowedActions?: readonly MemoryIpcAction[];
};

const DEFAULT_ALLOWED_MEMORY_IPC_ACTIONS = new Set<MemoryIpcAction>([
  'memory_search',
  'memory_save',
  'procedure_save',
]);

function parseOptionalString(
  value: unknown,
  opts: { maxLen?: number } = {},
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (opts.maxLen && trimmed.length > opts.maxLen) return undefined;
  return trimmed;
}

function parseOptionalNumber(
  value: unknown,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (opts.min !== undefined && value < opts.min) return undefined;
  if (opts.max !== undefined && value > opts.max) return undefined;
  return value;
}

function parseOptionalTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const parsed = parseOptionalString(item, { maxLen: 64 });
    if (!parsed) return undefined;
    out.push(parsed);
  }
  return out;
}

function parseMemoryScope(
  value: unknown,
): SaveMemoryInput['scope'] | SaveProcedureInput['scope'] | undefined {
  const scope = parseOptionalString(value, { maxLen: 16 });
  if (scope === 'user' || scope === 'group' || scope === 'global') return scope;
  return undefined;
}

function parseMemoryKind(value: unknown): SaveMemoryInput['kind'] | undefined {
  const kind = parseOptionalString(value, { maxLen: 32 });
  if (isDirectSaveMemoryKind(kind)) return kind;
  return undefined;
}

function parseDirectSaveMemoryKind(
  payload: Record<string, unknown>,
): SaveMemoryInput['kind'] | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, 'kind')) return undefined;
  const kind = parseMemoryKind(payload.kind);
  if (kind) return kind;
  throw new Error(
    'memory_save.kind must be one of preference, decision, fact, correction, or constraint',
  );
}

function parseSaveMemoryInput(payload: unknown): SaveMemoryInput {
  if (!isPlainObject(payload)) {
    throw new Error('memory_save payload must be an object');
  }
  const key = parseOptionalString(payload.key, { maxLen: 256 });
  const value = parseOptionalString(payload.value, { maxLen: 10_000 });
  if (!key || !value) {
    throw new Error('memory_save requires key and value');
  }
  const scope = parseMemoryScope(payload.scope);
  const kind = parseDirectSaveMemoryKind(payload);
  const groupFolder = parseOptionalString(payload.group_folder, {
    maxLen: 128,
  });
  const userId = parseOptionalString(payload.user_id, { maxLen: 255 });
  const confidence = parseOptionalNumber(payload.confidence, {
    min: 0,
    max: 1,
  });
  const why = parseOptionalString(payload.why, { maxLen: 500 });
  const sourceTurnId = parseOptionalString(payload.source_turn_id, {
    maxLen: 255,
  });
  const loadBearing =
    typeof payload.load_bearing === 'boolean'
      ? payload.load_bearing
      : undefined;
  const source = parseOptionalString(payload.source, { maxLen: 255 });
  const supersedes = Array.isArray(payload.supersedes)
    ? payload.supersedes
        .map((entry) => parseOptionalString(entry, { maxLen: 128 }))
        .filter((entry): entry is string => Boolean(entry))
    : undefined;
  return {
    key,
    value,
    ...(scope ? { scope } : {}),
    ...(kind ? { kind } : {}),
    ...(groupFolder ? { group_folder: groupFolder } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(why ? { why } : {}),
    ...(sourceTurnId ? { source_turn_id: sourceTurnId } : {}),
    ...(loadBearing !== undefined ? { load_bearing: loadBearing } : {}),
    ...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
    ...(source ? { source } : {}),
  };
}

function parsePatchMemoryInput(payload: unknown): PatchMemoryInput {
  if (!isPlainObject(payload)) {
    throw new Error('memory_patch payload must be an object');
  }
  const id = parseOptionalString(payload.id, { maxLen: 128 });
  const expectedVersion = parseOptionalNumber(payload.expected_version, {
    min: 1,
  });
  if (!id || expectedVersion === undefined) {
    throw new Error('memory_patch requires id and expected_version');
  }
  const key = parseOptionalString(payload.key, { maxLen: 256 });
  const value = parseOptionalString(payload.value, { maxLen: 10_000 });
  const confidence = parseOptionalNumber(payload.confidence, {
    min: 0,
    max: 1,
  });
  const why = parseOptionalString(payload.why, { maxLen: 500 });
  const loadBearing =
    typeof payload.load_bearing === 'boolean'
      ? payload.load_bearing
      : undefined;
  return {
    id,
    expected_version: Math.round(expectedVersion),
    ...(key ? { key } : {}),
    ...(value ? { value } : {}),
    ...(why ? { why } : {}),
    ...(loadBearing !== undefined ? { load_bearing: loadBearing } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function parseReviewDecisionInput(payload: unknown): {
  reviewId: string;
  decision: 'approve' | 'reject' | 'edit_approve';
  editedValue?: string;
  editedReason?: string;
} {
  if (!isPlainObject(payload)) {
    throw new Error('memory_review_decision payload must be an object');
  }
  const reviewId =
    parseOptionalString(payload.review_id, { maxLen: 128 }) ||
    parseOptionalString(payload.reviewId, { maxLen: 128 });
  const decision = parseOptionalString(payload.decision, { maxLen: 32 });
  if (!reviewId) throw new Error('memory_review_decision requires review_id');
  if (
    decision !== 'approve' &&
    decision !== 'reject' &&
    decision !== 'edit_approve'
  ) {
    throw new Error(
      'memory_review_decision.decision must be approve, reject, or edit_approve',
    );
  }
  const editedValue = parseOptionalString(payload.edited_value, {
    maxLen: 10_000,
  });
  const editedReason = parseOptionalString(payload.edited_reason, {
    maxLen: 500,
  });
  return {
    reviewId,
    decision,
    ...(editedValue ? { editedValue } : {}),
    ...(editedReason ? { editedReason } : {}),
  };
}

function assertValidRequestId(requestId: string): void {
  if (!MEMORY_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid memory IPC requestId');
  }
}

function assertMemoryActionAllowed(request: TrustedMemoryRequest): void {
  if (!MEMORY_IPC_ACTIONS.includes(request.action)) {
    throw new Error(`Unsupported memory action: ${request.action}`);
  }
  const allowedActions =
    request.allowedActions && request.allowedActions.length > 0
      ? new Set(request.allowedActions)
      : DEFAULT_ALLOWED_MEMORY_IPC_ACTIONS;
  if (!allowedActions.has(request.action)) {
    throw new Error(`Memory IPC action is not allowed: ${request.action}`);
  }
}

function resolveTrustedMemorySubject(
  sourceAgentFolder: string,
  context: TrustedMemoryContext | undefined,
  scope?: SaveMemoryInput['scope'] | SaveProcedureInput['scope'],
) {
  return resolveScopedMemorySubject({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForGroupFolder(sourceAgentFolder),
    groupId: sourceAgentFolder,
    conversationId: canonicalConversationIdForMemory(context?.chatJid),
    userId: context?.userId,
    threadId: context?.threadId,
    defaultScope: context?.defaultScope,
    ...(scope ? { scope } : {}),
  }).subject;
}

function parseSaveProcedureInput(payload: unknown): SaveProcedureInput {
  if (!isPlainObject(payload)) {
    throw new Error('procedure_save payload must be an object');
  }
  const title = parseOptionalString(payload.title, { maxLen: 256 });
  const body = parseOptionalString(payload.body, { maxLen: 50_000 });
  if (!title || !body) {
    throw new Error('procedure_save requires title and body');
  }
  const scope = parseMemoryScope(payload.scope);
  const groupFolder = parseOptionalString(payload.group_folder, {
    maxLen: 128,
  });
  const userId = parseOptionalString(payload.user_id, { maxLen: 255 });
  const tags = parseOptionalTags(payload.tags);
  const originRaw = parseOptionalString(payload.origin, { maxLen: 64 });
  const origin =
    originRaw === 'explicit' || originRaw === 'accepted_suggestion'
      ? originRaw
      : undefined;
  const trigger = parseOptionalString(payload.trigger, { maxLen: 280 });
  const confidence = parseOptionalNumber(payload.confidence, {
    min: 0,
    max: 1,
  });
  const source = parseOptionalString(payload.source, { maxLen: 255 });
  return {
    title,
    body,
    ...(scope ? { scope } : {}),
    ...(groupFolder ? { group_folder: groupFolder } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(tags ? { tags } : {}),
    ...(origin ? { origin } : {}),
    ...(trigger ? { trigger } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(source ? { source } : {}),
  };
}

function parsePatchProcedureInput(payload: unknown): PatchProcedureInput {
  if (!isPlainObject(payload)) {
    throw new Error('procedure_patch payload must be an object');
  }
  const id = parseOptionalString(payload.id, { maxLen: 128 });
  const expectedVersion = parseOptionalNumber(payload.expected_version, {
    min: 1,
  });
  if (!id || expectedVersion === undefined) {
    throw new Error('procedure_patch requires id and expected_version');
  }
  const title = parseOptionalString(payload.title, { maxLen: 256 });
  const body = parseOptionalString(payload.body, { maxLen: 50_000 });
  const tags = parseOptionalTags(payload.tags);
  const trigger =
    payload.trigger === null
      ? null
      : parseOptionalString(payload.trigger, { maxLen: 280 });
  const confidence = parseOptionalNumber(payload.confidence, {
    min: 0,
    max: 1,
  });
  return {
    id,
    expected_version: Math.round(expectedVersion),
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(tags ? { tags } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

export async function processMemoryRequest(
  request: TrustedMemoryRequest,
  sourceAgentFolder: string,
): Promise<MemoryIpcResponse> {
  let provider = 'uninitialized';

  try {
    assertValidRequestId(request.requestId);
    assertMemoryActionAllowed(request);
    const memory = AppMemoryService.getInstance();
    provider = 'postgres';
    logger.debug(
      { action: request.action, sourceAgentFolder, provider },
      'Processing memory IPC request',
    );

    switch (request.action) {
      case 'memory_search': {
        const query = String(request.payload.query || '').trim();
        if (!query) {
          throw new Error('query is required');
        }
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        // IPC memory reads are always scoped to the source group to prevent
        // cross-group data access from agent processes.
        const results = await memory.search({
          query,
          ...searchInputForResolvedMemorySubject(subject),
          limit: request.payload.limit
            ? Number(request.payload.limit)
            : undefined,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { results },
        };
      }
      case 'memory_save': {
        const input = {
          ...parseSaveMemoryInput(request.payload),
          ...(request.context?.threadId
            ? { topic_id: request.context.threadId }
            : {}),
        };
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
          input.scope,
        );
        const saved = await memory.save({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          kind: input.kind,
          key: input.key,
          value: input.value,
          why: input.why,
          confidence: input.confidence,
          source: input.source || 'mcp-tool',
          actorId: 'mcp-tool',
          isAdminWrite: false,
          evidenceText: input.why || input.value,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: saved },
        };
      }
      case 'memory_patch': {
        const input = parsePatchMemoryInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const patched = await memory.patch({
          ...subject,
          id: input.id,
          appId: DEFAULT_MEMORY_APP_ID,
          agentId: memoryAgentIdForGroupFolder(sourceAgentFolder),
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          key: input.key,
          value: input.value,
          why: input.why,
          confidence: input.confidence,
          isPinned: input.load_bearing,
          expectedVersion: input.expected_version,
          isAdminWrite: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: patched },
        };
      }
      case 'memory_consolidate': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const result = await memory.triggerDreaming({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          phase: 'deep',
          dryRun: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { consolidation: result },
        };
      }
      case 'memory_dream': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const result = await memory.triggerDreaming({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          phase: 'all',
          dryRun: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { dreaming: result },
        };
      }
      case 'memory_review_pending': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const reviews = await memory.listPendingReviews({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { reviews },
        };
      }
      case 'memory_review_decision': {
        const input = parseReviewDecisionInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        if (!request.context?.userId) {
          throw new Error(
            'memory_review_decision requires a trusted reviewer user id',
          );
        }
        const review = await memory.decideReview({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          ...input,
          reviewerId: request.context.userId,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { review },
        };
      }
      case 'procedure_save': {
        const input = {
          ...parseSaveProcedureInput(request.payload),
          ...(request.context?.threadId
            ? { topic_id: request.context.threadId }
            : {}),
        };
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
          input.scope,
        );
        const saved = await memory.save({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          kind: 'reference',
          key: `procedure:${input.title}`,
          value: input.body,
          why: input.trigger || undefined,
          confidence: input.confidence,
          source: input.source || 'mcp-tool',
          actorId: 'mcp-tool',
          isAdminWrite: false,
          evidenceText: input.body,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { procedure: saved },
        };
      }
      case 'procedure_patch': {
        const input = parsePatchProcedureInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        const patched = await memory.patch({
          ...subject,
          id: input.id,
          appId: DEFAULT_MEMORY_APP_ID,
          agentId: memoryAgentIdForGroupFolder(sourceAgentFolder),
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          key: input.title ? `procedure:${input.title}` : undefined,
          value: input.body,
          why: input.trigger === null ? null : input.trigger,
          confidence: input.confidence,
          expectedVersion: input.expected_version,
          isAdminWrite: false,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { procedure: patched },
        };
      }
      default:
        throw new Error(
          `Unsupported memory action: ${(request as { action?: string }).action || 'unknown'}`,
        );
    }
  } catch (err) {
    return {
      ok: false,
      requestId: request.requestId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function writeMemoryResponse(
  groupFolder: string,
  requestId: string,
  response: MemoryIpcResponse,
  privateKeyPem?: string,
): void {
  assertValidRequestId(requestId);
  const ipcDir = resolveGroupIpcPath(groupFolder);
  const responsesDir = path.join(ipcDir, 'memory-responses');
  ensurePrivateDirSync(responsesDir);

  const filePath = path.join(responsesDir, `${requestId}.json`);
  const tmpPath = `${filePath}.tmp`;
  const payload: Record<string, unknown> = {
    ok: response.ok,
    requestId: response.requestId,
    ...(response.provider ? { provider: response.provider } : {}),
    ...(response.data !== undefined ? { data: response.data } : {}),
    ...(response.error ? { error: response.error } : {}),
  };
  const signature = signIpcResponsePayload(privateKeyPem, payload);
  if (!signature) return;
  payload.signature = signature;
  writePrivateFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
}
